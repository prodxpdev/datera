import { DateraError } from '../errors.js';
import type { Engine } from '../engine/engine.js';
import { qualified, quoteIdent } from '../engine/sql.js';

/**
 * Authoring a dataset's shape directly, with no source attached (spec §3a).
 *
 * This is the Phase 1 *seam* for "author from intent", not the feature. It exists so the
 * data model cannot quietly grow the assumption that a dataset originates from a file —
 * an assumption that would be cheap to make now and expensive to unpick once the
 * authoring UI, AI-schema import, and backend generation are built on top.
 *
 * Two boundaries worth being explicit about:
 *
 *  - This is **structural** authoring — DDL in the workspace catalog. Declaring that a
 *    `customers` table exists is not the same act as changing 1,203 rows in one, and only
 *    the second belongs behind the §6 propose→preview→confirm gate. Conflating them would
 *    leave that gate guarding schema edits instead of the writes it was built for.
 *  - It writes to the **workspace**, never to a source. Invariant §1.2 is untouched: there
 *    is no path here that reaches a connected file or database.
 */

/** A column in an authored table. Types are DuckDB type names, validated before use. */
export interface AuthoredColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean | undefined;
  readonly primaryKey?: boolean | undefined;
}

export interface AuthoredTable {
  readonly name: string;
  readonly columns: readonly AuthoredColumn[];
}

/**
 * A declared relationship between two tables in the same dataset.
 *
 * Recorded in Datera's catalog rather than as a DuckDB foreign-key constraint. Two
 * reasons: relationships between *sources* are views over files and cannot carry
 * constraints at all, and Phase 3 needs relationships to hold a `suggested` /
 * `confirmed` state (invariant §1.3) that a database constraint has no room for. One
 * representation for both authored and detected relationships keeps Phase 3 from having
 * to reconcile two.
 */
export interface AuthoredRelationship {
  readonly id: string;
  readonly datasetId: string;
  readonly fromTable: string;
  readonly fromColumn: string;
  readonly toTable: string;
  readonly toColumn: string;
  /** Phase 1 authors relationships as 'confirmed'; Phase 3 adds 'suggested' detection. */
  readonly state: 'confirmed' | 'suggested';
  readonly createdAt: string;
}

/**
 * DuckDB type names accepted in an authored column.
 *
 * An allowlist rather than passing the string through: a type name is interpolated into
 * DDL and cannot be a bound parameter, so it is the one place an authored schema could
 * otherwise become SQL injection. Parameterised types (DECIMAL(p,s), and so on) are
 * matched by shape.
 */
const SCALAR_TYPES: ReadonlySet<string> = new Set([
  'BOOLEAN', 'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT',
  'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT',
  'FLOAT', 'DOUBLE', 'VARCHAR', 'BLOB', 'DATE', 'TIME', 'TIMESTAMP',
  'TIMESTAMP WITH TIME ZONE', 'INTERVAL', 'UUID', 'JSON',
]);

const PARAMETERISED = /^(DECIMAL|NUMERIC)\(\s*\d{1,2}\s*,\s*\d{1,2}\s*\)$/;

export function normaliseType(raw: string): string {
  const type = raw.trim().toUpperCase();
  if (SCALAR_TYPES.has(type)) return type;
  if (PARAMETERISED.test(type)) return type;
  if (type.endsWith('[]') && SCALAR_TYPES.has(type.slice(0, -2))) return type;

  throw new DateraError(
    'INVALID_ARGUMENT',
    `"${raw}" is not a column type Datera will author. Supported: ${[...SCALAR_TYPES].join(', ')}, DECIMAL(p,s), and arrays of those.`,
    { type: raw },
  );
}

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_ -]{0,62}$/u;

export function assertAuthorableName(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new DateraError(
      'INVALID_ARGUMENT',
      `"${name}" is not a usable ${what} name. Use a letter or underscore first, then letters, digits, underscores, spaces or hyphens (63 characters max).`,
      { name },
    );
  }
}

/**
 * Create a real, empty table inside a dataset's schema.
 *
 * A real table rather than a registered-but-absent definition, so that everything already
 * built reads it without a special case: introspection, preview, and the read-only query
 * path all see an authored table exactly as they see a connected source. That is the
 * point of the seam — one internal model, two entry paths (§3a).
 */
export async function createAuthoredTable(
  engine: Engine,
  schemaName: string,
  table: AuthoredTable,
): Promise<void> {
  assertAuthorableName(table.name, 'table');

  if (table.columns.length === 0) {
    throw new DateraError('INVALID_ARGUMENT', `Table "${table.name}" needs at least one column`, {
      table: table.name,
    });
  }

  const seen = new Set<string>();
  const definitions = table.columns.map((column) => {
    assertAuthorableName(column.name, 'column');
    const key = column.name.toLowerCase();
    if (seen.has(key)) {
      throw new DateraError('DUPLICATE_NAME', `Column "${column.name}" is defined twice`, {
        table: table.name,
        column: column.name,
      });
    }
    seen.add(key);

    const parts = [quoteIdent(column.name), normaliseType(column.type)];
    if (column.primaryKey === true) parts.push('PRIMARY KEY');
    else if (column.nullable === false) parts.push('NOT NULL');
    return parts.join(' ');
  });

  await engine.executeInternal(
    `CREATE TABLE ${qualified(schemaName, table.name)} (${definitions.join(', ')})`,
  );
}

export async function dropAuthoredTable(
  engine: Engine,
  schemaName: string,
  tableName: string,
): Promise<void> {
  await engine.executeInternal(`DROP TABLE IF EXISTS ${qualified(schemaName, tableName)}`);
}
