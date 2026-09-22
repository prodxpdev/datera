import type { Engine } from '../engine/engine.js';
import { quoteIdent, qualified } from '../engine/sql.js';
import { CATALOG_SCHEMA } from '../workspace/catalog.js';

/**
 * Versions — the third noun (spec §3).
 *
 * "Because the source is immutable and edits land on a copy, a version is just a copy at
 * a point in time." Versioning, non-destructive editing and backup are therefore **one
 * mechanism**, not three features, and this module is deliberately small because of it:
 * a snapshot is a schema copy, and a diff is two catalogs compared.
 */

export interface Version {
  readonly id: string;
  readonly datasetId: string;
  readonly label: string;
  readonly schemaName: string;
  readonly createdAt: string;
}

export interface RowCountChange {
  readonly table: string;
  readonly before: number | null;
  readonly after: number | null;
}

export interface ColumnChange {
  readonly table: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly retyped: readonly { column: string; before: string; after: string }[];
}

export interface VersionDiff {
  readonly from: string;
  readonly to: string;
  readonly tablesAdded: readonly string[];
  readonly tablesRemoved: readonly string[];
  readonly rowCountChanges: readonly RowCountChange[];
  readonly columnChanges: readonly ColumnChange[];
}

export async function migrateVersions(engine: Engine): Promise<void> {
  await engine.executeInternal(`
    CREATE TABLE IF NOT EXISTS ${CATALOG_SCHEMA}.versions (
      id VARCHAR PRIMARY KEY,
      dataset_id VARCHAR NOT NULL,
      label VARCHAR NOT NULL,
      schema_name VARCHAR NOT NULL,
      created_at VARCHAR NOT NULL
    )`);
}

/**
 * Snapshot a dataset by copying every table into a new schema.
 *
 * `CREATE TABLE AS SELECT` rather than a view: a view would follow the dataset forward and
 * a "version" that changes when the data changes is not a version.
 */
export async function saveVersion(
  engine: Engine,
  version: Version,
  sourceSchema: string,
): Promise<Version> {
  await engine.executeInternal(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(version.schemaName)}`);

  for (const table of await tablesIn(engine, sourceSchema)) {
    await engine.executeInternal(
      `CREATE TABLE ${qualified(version.schemaName, table)} AS SELECT * FROM ${qualified(sourceSchema, table)}`,
    );
  }

  await engine.executeInternal(
    `INSERT INTO ${CATALOG_SCHEMA}.versions (id, dataset_id, label, schema_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [version.id, version.datasetId, version.label, version.schemaName, version.createdAt],
  );

  return version;
}

export async function listVersions(engine: Engine, datasetId: string): Promise<readonly Version[]> {
  const result = await engine.executeInternal(
    `SELECT id, dataset_id, label, schema_name, created_at
     FROM ${CATALOG_SCHEMA}.versions WHERE dataset_id = ? ORDER BY created_at`,
    [datasetId],
  );
  return result.rows.map(toVersion);
}

export async function getVersion(engine: Engine, versionId: string): Promise<Version | null> {
  const result = await engine.executeInternal(
    `SELECT id, dataset_id, label, schema_name, created_at FROM ${CATALOG_SCHEMA}.versions WHERE id = ?`,
    [versionId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toVersion(row);
}

function toVersion(row: readonly unknown[]): Version {
  return {
    id: String(row[0]),
    datasetId: String(row[1]),
    label: String(row[2]),
    schemaName: String(row[3]),
    createdAt: String(row[4]),
  };
}

export async function tablesIn(engine: Engine, schemaName: string): Promise<readonly string[]> {
  const result = await engine.executeInternal(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
    [schemaName],
  );
  return result.rows.map((row) => String(row[0]));
}

/**
 * Compare two snapshots.
 *
 * Every number here is measured from the two schemas (§1.5). A model is never asked what
 * changed — "which rows changed" is a fact, and a fact that a diff got wrong would be
 * worse than no diff at all.
 */
export async function diffVersions(
  engine: Engine,
  from: Version,
  to: Version,
): Promise<VersionDiff> {
  const before = await tablesIn(engine, from.schemaName);
  const after = await tablesIn(engine, to.schemaName);

  const common = before.filter((t) => after.includes(t));

  const rowCountChanges: RowCountChange[] = [];
  const columnChanges: ColumnChange[] = [];

  for (const table of common) {
    const b = await countRows(engine, from.schemaName, table);
    const a = await countRows(engine, to.schemaName, table);
    if (b !== a) rowCountChanges.push({ table, before: b, after: a });
    else rowCountChanges.push({ table, before: b, after: a });

    const beforeColumns = await columnsOf(engine, from.schemaName, table);
    const afterColumns = await columnsOf(engine, to.schemaName, table);

    const added = [...afterColumns.keys()].filter((c) => !beforeColumns.has(c));
    const removed = [...beforeColumns.keys()].filter((c) => !afterColumns.has(c));
    const retyped = [...beforeColumns.entries()]
      .filter(([name, type]) => afterColumns.has(name) && afterColumns.get(name) !== type)
      .map(([name, type]) => ({ column: name, before: type, after: afterColumns.get(name) as string }));

    if (added.length > 0 || removed.length > 0 || retyped.length > 0) {
      columnChanges.push({ table, added, removed, retyped });
    }
  }

  return {
    from: from.id,
    to: to.id,
    tablesAdded: after.filter((t) => !before.includes(t)),
    tablesRemoved: before.filter((t) => !after.includes(t)),
    rowCountChanges,
    columnChanges,
  };
}

async function countRows(engine: Engine, schema: string, table: string): Promise<number> {
  const result = await engine.executeInternal(`SELECT count(*) FROM ${qualified(schema, table)}`);
  return Number(result.rows[0]?.[0] ?? 0);
}

async function columnsOf(
  engine: Engine,
  schema: string,
  table: string,
): Promise<ReadonlyMap<string, string>> {
  const result = await engine.executeInternal(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
    [schema, table],
  );
  return new Map(result.rows.map((row) => [String(row[0]), String(row[1])]));
}
