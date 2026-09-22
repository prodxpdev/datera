import type { Datera } from '@datera/core';

/**
 * The database half of the §12.1 assertion.
 *
 * A live Postgres or MySQL has no file to hash, so "unchanged" is established from what
 * is observable through a connection: the set of tables, each table's row count, and a
 * content checksum per table. Together these catch an inserted row, a deleted row, an
 * updated value, and a created or dropped object.
 *
 * This is weaker than a byte hash and it is worth being honest about the gap: it would
 * not notice a change that preserved both the row count and the checksum, nor a change to
 * an object outside the tables being watched. It is the strongest check available through
 * a read-only connection, which is the only kind of connection Datera opens.
 */
export interface DatabaseFingerprint {
  readonly alias: string;
  readonly tables: readonly TableFingerprint[];
}

export interface TableFingerprint {
  readonly table: string;
  readonly rowCount: number;
  readonly checksum: string;
}

/**
 * Fingerprint every table in an attached database.
 *
 * Runs through the supplied query function, which in tests is Datera's own guarded query
 * path — so the fingerprinting itself is subject to the same read-only rules as
 * everything else and cannot be the thing that mutates the database.
 */
export async function fingerprintAttachedDatabase(
  query: (sql: string) => Promise<readonly (readonly unknown[])[]>,
  alias: string,
): Promise<DatabaseFingerprint> {
  const tableRows = await query(
    `SELECT table_name FROM duckdb_tables() WHERE database_name = '${alias}' ORDER BY table_name`,
  );
  const tables: TableFingerprint[] = [];

  for (const row of tableRows) {
    const table = String(row[0]);
    const quoted = `"${alias}"."${table.replace(/"/g, '""')}"`;

    const countRows = await query(`SELECT count(*) FROM ${quoted}`);
    const rowCount = Number(countRows[0]?.[0] ?? 0);

    // bit_xor over per-row hashes: order-independent, so a fingerprint does not depend on
    // scan order, which is not guaranteed stable across engines or plans. The row is cast
    // to text first because hash() takes a value, and the whole-row struct is the value
    // that actually represents "this row's contents".
    const checksumRows = await query(
      `SELECT coalesce(CAST(bit_xor(hash(CAST(t AS VARCHAR))) AS VARCHAR), '0') FROM ${quoted} t`,
    );
    tables.push({ table, rowCount, checksum: String(checksumRows[0]?.[0] ?? '0') });
  }

  return { alias, tables };
}

export interface DatabaseDifference {
  readonly table: string;
  readonly field: 'present' | 'rowCount' | 'checksum';
  readonly before: string | number;
  readonly after: string | number;
}

export function diffDatabaseFingerprints(
  before: DatabaseFingerprint,
  after: DatabaseFingerprint,
): readonly DatabaseDifference[] {
  const differences: DatabaseDifference[] = [];
  const afterByName = new Map(after.tables.map((t) => [t.table, t]));

  for (const b of before.tables) {
    const a = afterByName.get(b.table);
    if (a === undefined) {
      differences.push({ table: b.table, field: 'present', before: 'present', after: 'missing' });
      continue;
    }
    if (a.rowCount !== b.rowCount) {
      differences.push({ table: b.table, field: 'rowCount', before: b.rowCount, after: a.rowCount });
    }
    if (a.checksum !== b.checksum) {
      differences.push({ table: b.table, field: 'checksum', before: b.checksum, after: a.checksum });
    }
  }

  const beforeNames = new Set(before.tables.map((t) => t.table));
  for (const a of after.tables) {
    if (!beforeNames.has(a.table)) {
      differences.push({ table: a.table, field: 'present', before: 'missing', after: 'present' });
    }
  }

  return differences;
}

/** Convenience: fingerprint through a Datera instance's guarded query path. */
export function queryThrough(datera: Datera, datasetId: string) {
  return async (sql: string): Promise<readonly (readonly unknown[])[]> => {
    const result = await datera.query(datasetId, sql);
    return result.rows;
  };
}
