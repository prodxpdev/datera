import { asDateraError } from '../errors.js';
import type { Engine } from '../engine/engine.js';
import { qualified, quoteIdent } from '../engine/sql.js';
import type { Source } from '../sources/types.js';
import { analyseColumn, type InferenceNote } from './inference.js';

export interface ColumnSchema {
  readonly name: string;
  /** The DuckDB type, verbatim. */
  readonly type: string;
  /**
   * Whether DuckDB *declares* the column nullable. For a view over a file this is almost
   * always true and therefore nearly meaningless, which is why `nullCount` exists.
   */
  readonly declaredNullable: boolean;
  /** Observed nulls in the source. This is the number worth showing a user. */
  readonly nullCount: number;
  readonly sampleValues: readonly string[];
  /** Present when the inferred type deserves a caveat. See schema/inference.ts. */
  readonly inference: InferenceNote | null;
}

export interface SourceSchema {
  /** Null for an authored table, which has no source behind it (spec §3a). */
  readonly sourceId: string | null;
  readonly sourceName: string;
  readonly datasetId: string;
  readonly rowCount: number;
  readonly columns: readonly ColumnSchema[];
}

const SAMPLE_LIMIT = 5;
/** Rows examined when testing whether a VARCHAR column is really something narrower. */
const INFERENCE_SAMPLE_ROWS = 1000;

/**
 * Describe a source: columns, types, observed nulls, samples, and any inference caveat.
 *
 * Phase 3's dictionary auto-draft consumes exactly this output, which is why samples and
 * inference notes are part of the schema rather than a separate call.
 */
export async function introspectSource(
  engine: Engine,
  source: Source,
  schemaName: string,
): Promise<SourceSchema> {
  return introspectRelation(engine, schemaName, source.name, source.datasetId, {
    sourceId: source.id,
    origin: source.origin,
  });
}

/**
 * Introspect any relation in a dataset schema by name.
 *
 * Name-addressed rather than source-addressed, because an authored table (spec §3a) has
 * no source behind it. Both entry paths land here, which is what makes "connect a source"
 * and "author from intent" produce genuinely the same internal model rather than two that
 * merely look alike.
 */
export async function introspectRelation(
  engine: Engine,
  schemaName: string,
  relationName: string,
  datasetId: string,
  provenance: { readonly sourceId?: string; readonly origin?: string } = {},
): Promise<SourceSchema> {
  const target = qualified(schemaName, relationName);

  let described;
  try {
    described = await engine.executeInternal(`DESCRIBE ${target}`);
  } catch (e) {
    throw asDateraError(e, 'SOURCE_UNAVAILABLE', `Could not read the schema of "${relationName}"`, {
      ...provenance,
      schemaName,
      relation: relationName,
    });
  }

  const columns = described.rows.map((row) => ({
    name: String(row[0]),
    type: String(row[1]),
    declaredNullable: String(row[2]).toUpperCase() !== 'NO',
  }));

  const rowCount = await countRows(engine, target);
  const nullCounts = await countNulls(engine, target, columns.map((c) => c.name));
  const samples = await sampleValues(engine, target, columns.map((c) => c.name));

  const analysed: ColumnSchema[] = [];
  for (const [i, column] of columns.entries()) {
    analysed.push({
      name: column.name,
      type: column.type,
      declaredNullable: column.declaredNullable,
      nullCount: nullCounts[i] ?? 0,
      sampleValues: samples[i] ?? [],
      inference: await analyseColumn(engine, target, column.name, column.type, INFERENCE_SAMPLE_ROWS),
    });
  }

  return {
    sourceId: provenance.sourceId ?? null,
    sourceName: relationName,
    datasetId,
    rowCount,
    columns: analysed,
  };
}

async function countRows(engine: Engine, target: string): Promise<number> {
  const result = await engine.executeInternal(`SELECT count(*) FROM ${target}`);
  return Number(result.rows[0]?.[0] ?? 0);
}

/** One pass over the source for every column, rather than one pass per column. */
async function countNulls(
  engine: Engine,
  target: string,
  names: readonly string[],
): Promise<readonly number[]> {
  if (names.length === 0) return [];
  const projections = names
    .map((n, i) => `count(*) - count(${quoteIdent(n)}) AS n${i}`)
    .join(', ');
  const result = await engine.executeInternal(`SELECT ${projections} FROM ${target}`);
  const row = result.rows[0] ?? [];
  return names.map((_, i) => Number(row[i] ?? 0));
}

async function sampleValues(
  engine: Engine,
  target: string,
  names: readonly string[],
): Promise<readonly (readonly string[])[]> {
  if (names.length === 0) return [];
  const result = await engine.executeInternal(`SELECT * FROM ${target} LIMIT ${SAMPLE_LIMIT}`);
  return names.map((_, colIndex) =>
    result.rows
      .map((row) => row[colIndex])
      .filter((v): v is NonNullable<unknown> => v !== null && v !== undefined)
      .map((v) => String(v)),
  );
}
