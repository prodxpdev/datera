/**
 * Dataset — the second noun (spec §3), and the boundary that governs everything:
 * join scope, query scope, and later write, transaction and version scope.
 *
 * Each dataset is its own DuckDB schema. That is not an implementation detail; it is the
 * mechanism by which sources in different datasets "can never be joined by accident"
 * (spec §3, acceptance §12.4). Phase 1 ships exactly one dataset — the default
 * "Ungrouped" — so that the boundary exists from the first commit rather than being
 * retrofitted in Phase 3 (decision D-04).
 */
export type DatasetKind = 'connected' | 'derived' | 'imported' | 'system';

export interface Dataset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The DuckDB schema backing this dataset. */
  readonly schemaName: string;
  /** The implicit dataset that new sources land in when none is named. */
  readonly isDefault: boolean;
  /**
   * How this dataset came to exist.
   *
   * `derived` is the copy-on-write result (§1.2) — real tables, safe to edit, with the
   * original untouched. Recording it means the UI can say "this is a copy" rather than
   * leaving a user to guess which of two similar datasets is the sacred one.
   *
   * `system` is Datera's own — today just the activity log (§8a). It is queryable exactly
   * like any other dataset, which is the point, but it never takes sources, never takes a
   * write grant, and is never pushed anywhere.
   */
  readonly kind: DatasetKind;
  /** For a derived dataset: the dataset it was copied from. */
  readonly derivedFrom?: string | undefined;
  readonly createdAt: string;
}

export const DEFAULT_DATASET_ID = 'ungrouped';

/**
 * The request log, as a dataset (§8a).
 *
 * §8a wants the log searchable by SQL *and* NL with the SQL shown, and in the same breath
 * forbids it becoming its own pillar with a second query stack behind it. Making it a
 * dataset satisfies both at once: everything that already works on datasets — the editor,
 * NL→SQL, completions, the schema map, the visible SQL — works on the log for free.
 *
 * Its schema holds exactly one view over the log and nothing else, so the standing refusal
 * to read `_datera` through the user query path is untouched.
 */
export const ACTIVITY_DATASET_ID = 'activity';
export const ACTIVITY_DATASET_SCHEMA = 'ds_activity';
export const ACTIVITY_DATASET_NAME = 'Activity log';
export const ACTIVITY_DATASET_DESCRIPTION =
  'Every request Datera has answered — local, API and MCP — as a table you can query. ' +
  'Read-only, bounded by the retention window, and holding shape and metadata rather than ' +
  'your rows unless payload capture is explicitly on.';
export const DEFAULT_DATASET_SCHEMA = 'ds_ungrouped';
export const DEFAULT_DATASET_NAME = 'Ungrouped';
export const DEFAULT_DATASET_DESCRIPTION =
  'Sources that have not been grouped yet. Queries here run against one source at a time until you group sources that share a key.';
