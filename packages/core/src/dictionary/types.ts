/**
 * The dictionary — the semantic layer (spec §4).
 *
 * Vague or missing column meanings are the top cause of bad NL→SQL. This layer is the
 * fix: it tells the model that `revenue_cents` is money in minor units and that people
 * call it "sales", so "what were my sales?" becomes `SUM(revenue_cents)/100` instead of a
 * number a hundred times too large that looks entirely plausible.
 */

/** §1.3 — every item is proposed, then ratified. Nothing skips the middle state. */
export type DefinitionState = 'confirmed' | 'suggested' | 'undefined';

export type ColumnRole = 'measure' | 'dimension' | 'id' | 'time' | 'flag' | 'text';

/**
 * `hidden` means "never show this column to a model" (§4, hide-from-NL).
 *
 * Stronger than it sounds: the column is removed from the schema context entirely, so not
 * even its *name* is sent. A column called `patient_ssn` leaks something by existing.
 */
export type Sensitivity = 'normal' | 'hidden';

export interface EnumValueMeaning {
  readonly value: string;
  readonly meaning: string;
}

export interface ColumnDefinition {
  readonly column: string;
  readonly meaning: string;
  /** What people call it when asking — "sales", "rev". Drives NL matching. */
  readonly aliases: readonly string[];
  /** e.g. 'cents → USD (÷100)'. Free text, because units are not a closed set. */
  readonly unit: string;
  readonly role: ColumnRole;
  readonly sensitivity: Sensitivity;
  /** For categorical and boolean columns: what each value actually means. */
  readonly enumValues?: readonly EnumValueMeaning[] | undefined;
  readonly state: DefinitionState;
}

export interface EntityDefinition {
  /** What one row is. */
  readonly meaning: string;
  /** e.g. 'one row per order'. The thing people get wrong when joining. */
  readonly grain: string;
  readonly primaryKey: string;
  readonly state: DefinitionState;
}

export interface SourceDictionary {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly entity: EntityDefinition;
  readonly columns: readonly ColumnDefinition[];
}

export const UNDEFINED_ENTITY: EntityDefinition = {
  meaning: '',
  grain: '',
  primaryKey: '',
  state: 'undefined',
};

/** Only confirmed definitions are facts. Suggestions are not shown to a model (§1.3). */
export function confirmedOnly(dictionary: SourceDictionary): SourceDictionary {
  return {
    ...dictionary,
    entity: dictionary.entity.state === 'confirmed' ? dictionary.entity : UNDEFINED_ENTITY,
    columns: dictionary.columns.filter((c) => c.state === 'confirmed'),
  };
}
