import type { Engine } from '../engine/engine.js';
import { quoteIdent, quoteLiteral } from '../engine/sql.js';
import { CATALOG_SCHEMA } from '../workspace/catalog.js';

/**
 * Where embedded chunks live.
 *
 * One table in Datera's own schema rather than one per dataset, with `dataset_id` on
 * every row. The dataset boundary is enforced here by the `WHERE dataset_id = ?` on every
 * read — vectors from one dataset can never surface in another's search, which is §12.4
 * applied to the semantic path as well as the SQL one.
 *
 * Vectors are stored as `FLOAT[]`. `array_cosine_similarity` is a core DuckDB function,
 * so retrieval needs no extension; the optional `vss` extension only adds HNSW indexing
 * for corpora large enough to care.
 */

export interface StoredChunk {
  readonly id: string;
  readonly datasetId: string;
  readonly sourceName: string;
  readonly column: string;
  /** Primary-key-ish value identifying the row this chunk came from, for citation. */
  readonly rowKey: string;
  readonly text: string;
  /** sha-256 of the text, so unchanged text is never re-embedded. */
  readonly textHash: string;
}

export interface SearchHit {
  readonly source: string;
  readonly column: string;
  readonly rowKey: string;
  readonly text: string;
  readonly score: number;
}

export async function migrateEmbeddings(engine: Engine): Promise<void> {
  await engine.executeInternal(`
    CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.embeddings (
      id VARCHAR PRIMARY KEY,
      dataset_id VARCHAR NOT NULL,
      source_name VARCHAR NOT NULL,
      column_name VARCHAR NOT NULL,
      row_key VARCHAR NOT NULL,
      text VARCHAR NOT NULL,
      text_hash VARCHAR NOT NULL,
      model_id VARCHAR NOT NULL,
      vector FLOAT[] NOT NULL
    )`);
}

/** Hashes already embedded with this model, so a rebuild only does the new work. */
export async function existingHashes(
  engine: Engine,
  datasetId: string,
  modelId: string,
): Promise<ReadonlySet<string>> {
  const result = await engine.executeInternal(
    `SELECT text_hash FROM ${CATALOG_SCHEMA}.embeddings WHERE dataset_id = ? AND model_id = ?`,
    [datasetId, modelId],
  );
  return new Set(result.rows.map((row) => String(row[0])));
}

export async function insertChunks(
  engine: Engine,
  chunks: readonly StoredChunk[],
  vectors: readonly (readonly number[])[],
  modelId: string,
): Promise<void> {
  for (const [i, chunk] of chunks.entries()) {
    const vector = vectors[i];
    if (vector === undefined) continue;

    // The vector is interpolated as a literal array rather than bound: DuckDB's parameter
    // binding has no FLOAT[] form through this driver, and the values are numbers Datera
    // produced, not user text.
    const literal = `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]::FLOAT[]`;

    await engine.executeInternal(
      `INSERT OR REPLACE INTO ${CATALOG_SCHEMA}.embeddings
         (id, dataset_id, source_name, column_name, row_key, text, text_hash, model_id, vector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${literal})`,
      [chunk.id, chunk.datasetId, chunk.sourceName, chunk.column, chunk.rowKey, chunk.text, chunk.textHash, modelId],
    );
  }
}

/** Top-k by cosine similarity, scoped to one dataset. */
export async function searchVectors(
  engine: Engine,
  datasetId: string,
  queryVector: readonly number[],
  k: number,
): Promise<readonly SearchHit[]> {
  const literal = `[${queryVector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]::FLOAT[]`;

  const result = await engine.executeInternal(
    `SELECT source_name, column_name, row_key, text,
            array_cosine_similarity(vector::FLOAT[${queryVector.length}], ${literal.replace('FLOAT[]', `FLOAT[${queryVector.length}]`)}) AS score
     FROM ${CATALOG_SCHEMA}.embeddings
     WHERE dataset_id = ${quoteLiteral(datasetId)}
       AND len(vector) = ${queryVector.length}
     ORDER BY score DESC
     LIMIT ${Math.max(1, Math.trunc(k))}`,
  );

  return result.rows.map((row) => ({
    source: String(row[0]),
    column: String(row[1]),
    rowKey: String(row[2]),
    text: String(row[3]),
    score: Number(row[4]),
  }));
}

export async function countEmbedded(engine: Engine, datasetId: string): Promise<number> {
  const result = await engine.executeInternal(
    `SELECT count(*) FROM ${CATALOG_SCHEMA}.embeddings WHERE dataset_id = ?`,
    [datasetId],
  );
  return Number(result.rows[0]?.[0] ?? 0);
}

/** Distinct embedded columns for a dataset — the router needs to know if any exist. */
export async function embeddedColumns(engine: Engine, datasetId: string): Promise<readonly string[]> {
  const result = await engine.executeInternal(
    `SELECT DISTINCT column_name FROM ${CATALOG_SCHEMA}.embeddings WHERE dataset_id = ? ORDER BY 1`,
    [datasetId],
  );
  return result.rows.map((row) => String(row[0]));
}

/** Read the text of a column, with a key for citation. */
export async function readTextColumn(
  engine: Engine,
  schemaName: string,
  sourceName: string,
  column: string,
  keyColumn: string | null,
  limit: number,
): Promise<readonly { rowKey: string; text: string }[]> {
  const key = keyColumn === null ? 'CAST(rowid AS VARCHAR)' : `CAST(${quoteIdent(keyColumn)} AS VARCHAR)`;
  const result = await engine.executeInternal(
    `SELECT ${key} AS k, CAST(${quoteIdent(column)} AS VARCHAR) AS t
     FROM ${quoteIdent(schemaName)}.${quoteIdent(sourceName)}
     WHERE ${quoteIdent(column)} IS NOT NULL
     LIMIT ${limit}`,
  );
  return result.rows.map((row) => ({ rowKey: String(row[0]), text: String(row[1]) }));
}
