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
export interface Dataset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The DuckDB schema backing this dataset. */
  readonly schemaName: string;
  /** The implicit dataset that new sources land in when none is named. */
  readonly isDefault: boolean;
  readonly createdAt: string;
}

export const DEFAULT_DATASET_ID = 'ungrouped';
export const DEFAULT_DATASET_SCHEMA = 'ds_ungrouped';
export const DEFAULT_DATASET_NAME = 'Ungrouped';
export const DEFAULT_DATASET_DESCRIPTION =
  'Sources that have not been grouped yet. Queries here run against one source at a time until you group sources that share a key.';
