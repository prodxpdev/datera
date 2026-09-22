import type { Engine } from '../engine/engine.js';
import { qualified, quoteIdent } from '../engine/sql.js';
import type { ColumnSchema, SourceSchema } from '../schema/introspect.js';
import type {
  ColumnDefinition,
  ColumnRole,
  EntityDefinition,
  EnumValueMeaning,
  SourceDictionary,
} from './types.js';

/**
 * Auto-draft a dictionary from what is actually in the data (spec §4).
 *
 * Computed in code, not asked of a model. Three reasons, and they compound:
 *
 *  - **It is reproducible.** The same source drafts identically every time, so a user can
 *    re-draft without wondering what changed.
 *  - **It works offline, instantly, with no model configured** — which is the state a
 *    fresh install is in, and the dictionary is most valuable *before* you have a good
 *    model, not after.
 *  - **Invariant §1.5.** Primary keys and enum value sets are facts about the data, and
 *    facts are measured. Asking a model whether a column is unique, when a `count(distinct)`
 *    can answer it exactly, would be choosing a guess over an answer.
 *
 * Everything here is a *proposal*. Nothing is confirmed (§1.3).
 */

/** Suffixes that reliably indicate minor currency units. */
const MONEY_SUFFIXES = ['_cents', '_cent', '_pence', '_minor', '_cts'] as const;

/** Name fragments that suggest a role, checked in order. */
const TIME_HINTS = ['_at', '_date', '_time', '_on', 'timestamp', 'date'] as const;
const ID_HINTS = ['_id', 'id_', 'uuid', '_key', '_code', '_no', '_number'] as const;
const FLAG_HINTS = ['is_', 'has_', 'was_', '_flag', 'refunded', 'active', 'enabled', 'deleted'] as const;
const MEASURE_HINTS = [
  'amount', 'total', 'sum', 'count', 'qty', 'quantity', 'price', 'cost', 'revenue',
  'spend', 'value', 'score', 'rate', 'ltv', 'balance', 'weight', 'duration',
] as const;

/** How many distinct values a column may have before it stops being enum-like. */
const MAX_ENUM_VALUES = 12;
/** Rows sampled when measuring distinctness. Bounded so drafting a huge table stays quick. */
const SAMPLE_ROWS = 50_000;

export async function draftDictionary(
  engine: Engine,
  schemaName: string,
  schema: SourceSchema,
): Promise<SourceDictionary> {
  const target = qualified(schemaName, schema.sourceName);

  const columns: ColumnDefinition[] = [];
  for (const column of schema.columns) {
    columns.push({
      column: column.name,
      meaning: describeColumn(column, schema.sourceName),
      aliases: proposeAliases(column.name),
      unit: proposeUnit(column),
      role: proposeRole(column),
      sensitivity: 'normal',
      ...(await proposeEnumValues(engine, target, column)),
      // §1.3 — a draft is a proposal, always.
      state: 'suggested',
    });
  }

  return {
    sourceId: schema.sourceId ?? '',
    sourceName: schema.sourceName,
    entity: await proposeEntity(engine, target, schema),
    columns,
  };
}

function normalise(name: string): string {
  return name.toLowerCase();
}

/** Strip a known minor-unit suffix, so `revenue_cents` yields `revenue`. */
function stripMoneySuffix(name: string): string | null {
  const lower = normalise(name);
  for (const suffix of MONEY_SUFFIXES) {
    if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length);
  }
  return null;
}

export function proposeRole(column: ColumnSchema): ColumnRole {
  const name = normalise(column.name);
  const type = column.type.toUpperCase();

  if (type.startsWith('BOOLEAN')) return 'flag';
  if (type.includes('TIMESTAMP') || type.includes('DATE') || type.startsWith('TIME')) return 'time';
  if (FLAG_HINTS.some((h) => name.startsWith(h) || name.endsWith(h) || name === h)) return 'flag';
  if (TIME_HINTS.some((h) => name.endsWith(h))) return 'time';
  if (type === 'UUID' || ID_HINTS.some((h) => name.endsWith(h) || name.startsWith(h))) return 'id';

  const numeric =
    type.includes('INT') || type.includes('DECIMAL') || type.includes('DOUBLE') ||
    type.includes('FLOAT') || type.includes('NUMERIC') || type.includes('HUGEINT');

  if (numeric) {
    // A numeric column with a measure-ish name is almost always something to aggregate.
    if (stripMoneySuffix(name) !== null) return 'measure';
    if (MEASURE_HINTS.some((h) => name.includes(h))) return 'measure';
    return 'measure';
  }

  // Long free text is for reading, not grouping — and Phase 4 embeds exactly these.
  if (type === 'VARCHAR' && looksLikeProse(column)) return 'text';
  return 'dimension';
}

function looksLikeProse(column: ColumnSchema): boolean {
  const samples = column.sampleValues;
  if (samples.length === 0) return false;
  const average = samples.reduce((n, s) => n + s.length, 0) / samples.length;
  return average > 40 || samples.some((s) => s.trim().includes(' ') && s.length > 60);
}

export function proposeAliases(name: string): readonly string[] {
  const lower = normalise(name);
  const aliases = new Set<string>();

  const withoutMoney = stripMoneySuffix(lower);
  if (withoutMoney !== null && withoutMoney.length > 0) {
    aliases.add(withoutMoney.replace(/_/g, ' '));
  }

  // Words, so `created_at` also answers to "created".
  const words = lower.split(/[_\s]+/).filter((w) => w.length > 2);
  if (words.length > 1) aliases.add(words.join(' '));

  const base = withoutMoney ?? lower;
  for (const [needle, extra] of SYNONYMS) {
    if (base.includes(needle)) for (const e of extra) aliases.add(e);
  }

  aliases.delete(lower);
  return [...aliases];
}

/**
 * The handful of synonyms worth shipping.
 *
 * Deliberately small. A long guessed list makes NL matching *worse* by pulling questions
 * towards the wrong column, and the user can add the ones that matter for their data —
 * which is the whole point of the dictionary being editable.
 */
const SYNONYMS: readonly (readonly [string, readonly string[]])[] = [
  ['revenue', ['sales', 'income', 'takings']],
  ['qty', ['quantity', 'units']],
  ['quantity', ['qty', 'units']],
  ['ltv', ['lifetime value']],
  ['created', ['date', 'placed', 'when']],
  ['customer', ['client', 'account']],
  ['product', ['item', 'sku']],
  ['spend', ['cost', 'outlay']],
];

export function proposeUnit(column: ColumnSchema): string {
  const base = stripMoneySuffix(column.name);
  if (base !== null) {
    // The off-by-100 money bug is the canonical example in the spec's own teaching module.
    return 'minor units (cents) → divide by 100.0 for a currency amount';
  }
  if (column.type.toUpperCase().includes('TIMESTAMP')) return 'timestamp';
  return '';
}

function describeColumn(column: ColumnSchema, sourceName: string): string {
  const base = stripMoneySuffix(column.name);
  if (base !== null) {
    return `${humanise(base)} for the ${humanise(sourceName)} row, stored in minor units.`;
  }
  return `${humanise(column.name)} of the ${humanise(sourceName)} row.`;
}

function humanise(name: string): string {
  const words = name.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Propose enum meanings for a column with a small distinct value set.
 *
 * The values are read; the *meanings* are left blank for a human, except for booleans
 * where the meaning is genuinely known. Inventing prose for a value Datera has never
 * seen explained would be fabrication dressed as help.
 */
async function proposeEnumValues(
  engine: Engine,
  target: string,
  column: ColumnSchema,
): Promise<{ enumValues?: readonly EnumValueMeaning[] }> {
  const role = proposeRole(column);
  if (role === 'measure' || role === 'time' || role === 'text' || role === 'id') return {};

  const col = quoteIdent(column.name);
  const result = await engine.executeInternal(
    `SELECT DISTINCT CAST(${col} AS VARCHAR) AS v
     FROM (SELECT ${col} FROM ${target} WHERE ${col} IS NOT NULL LIMIT ${SAMPLE_ROWS})
     ORDER BY 1 LIMIT ${MAX_ENUM_VALUES + 1}`,
  );

  if (result.rows.length === 0 || result.rows.length > MAX_ENUM_VALUES) return {};

  return {
    enumValues: result.rows.map((row) => {
      const value = String(row[0]);
      return { value, meaning: booleanMeaning(value) };
    }),
  };
}

function booleanMeaning(value: string): string {
  if (value === 'true') return 'yes';
  if (value === 'false') return 'no';
  return '';
}

/**
 * Propose the entity: what one row is, and which column identifies it.
 *
 * The primary key is *measured* — a column is proposed only if it is genuinely unique and
 * non-null across the sample. A column called `id` that repeats is not a key, and saying
 * so would send every future join wrong.
 */
async function proposeEntity(
  engine: Engine,
  target: string,
  schema: SourceSchema,
): Promise<EntityDefinition> {
  const candidates = schema.columns.filter((c) => proposeRole(c) === 'id' || c.nullCount === 0);

  let primaryKey = '';
  for (const candidate of candidates) {
    const col = quoteIdent(candidate.name);
    const result = await engine.executeInternal(
      `SELECT count(*) AS n, count(DISTINCT ${col}) AS d, count(${col}) AS nonnull FROM ${target}`,
    );
    const row = result.rows[0];
    if (row === undefined) continue;

    const total = Number(row[0]);
    const distinct = Number(row[1]);
    const nonNull = Number(row[2]);

    if (total > 0 && distinct === total && nonNull === total) {
      primaryKey = candidate.name;
      break;
    }
  }

  const noun = humanise(schema.sourceName).replace(/s$/, '');
  return {
    meaning: `A single ${noun.toLowerCase()} record.`,
    grain: `one row per ${noun.toLowerCase()}`,
    primaryKey,
    state: 'suggested',
  };
}
