import { DateraError } from '../errors.js';
import type { DuckDBConnectionPort } from '../ports/duckdb.js';
import { quoteLiteral } from '../engine/sql.js';

/**
 * The dataset boundary, enforced (spec §3, acceptance §12.4).
 *
 * Setting `search_path` to the active dataset's schema makes unqualified names resolve
 * inside it. That is scoping, and scoping is not isolation: nothing stops a user — or a
 * model — writing `ds_other.customers` explicitly. Spec §3 says sources in different
 * datasets "can never be joined by accident", and a default is not a guarantee.
 *
 * So every table reference is extracted from DuckDB's own parse tree and checked. The AST
 * is walked rather than the text scanned, because a text scan is defeated by a CTE, a
 * subquery, a comment, or a string literal — and this is a correctness boundary.
 */

export interface TableReference {
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
}

/**
 * Schemas a query may touch besides the active dataset.
 *
 * Deliberately tiny. `_datera` is Datera's own bookkeeping and is *not* here: it holds the
 * catalog of every dataset, so exposing it through the user query path would leak the
 * existence and shape of data the active dataset is supposed to be walled off from.
 */
const ALWAYS_ALLOWED_SCHEMAS: ReadonlySet<string> = new Set(['information_schema', 'pg_catalog']);

/**
 * Pull every base-table reference out of a statement, without executing it.
 *
 * Returns null when DuckDB will not serialise the statement — which happens for anything
 * that is not a single SELECT. The caller treats that as "cannot verify", and the
 * read-only guard has already refused those statements anyway.
 */
export async function extractTableReferences(
  conn: DuckDBConnectionPort,
  sql: string,
): Promise<readonly TableReference[] | null> {
  let body: string;
  try {
    const result = await conn.run(`SELECT json_serialize_sql(${quoteLiteral(sql)})`);
    const raw = result.rows[0]?.[0];
    if (typeof raw !== 'string') return null;
    body = raw;
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed === 'object' && parsed !== null && (parsed as { error?: unknown }).error === true) {
    return null;
  }

  const found: TableReference[] = [];
  walk(parsed, found);
  return found;
}

function walk(node: unknown, out: TableReference[]): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  const record = node as Record<string, unknown>;
  if (record['type'] === 'BASE_TABLE' && typeof record['table_name'] === 'string') {
    out.push({
      catalog: typeof record['catalog_name'] === 'string' ? record['catalog_name'] : '',
      schema: typeof record['schema_name'] === 'string' ? record['schema_name'] : '',
      table: record['table_name'],
    });
  }

  for (const value of Object.values(record)) walk(value, out);
}

export interface ScopeCheck {
  readonly references: readonly TableReference[];
  /** References that resolve through `search_path` rather than naming a schema. */
  readonly unqualified: readonly TableReference[];
}

/**
 * Throw unless every table reference stays inside the active dataset.
 *
 * Unqualified references are allowed: `search_path` is set to the dataset's schema, so
 * they resolve there, and a name that only exists in another dataset simply will not
 * resolve. Qualified references must name the active dataset's schema — anything else is
 * a deliberate reach across the boundary and is refused.
 *
 * A CTE name also parses as a BASE_TABLE with no schema, which is exactly why unqualified
 * references are permitted rather than matched against the source list.
 */
export async function assertWithinDataset(
  conn: DuckDBConnectionPort,
  sql: string,
  activeSchema: string,
  datasetName: string,
  schemaToDataset: ReadonlyMap<string, string>,
  /**
   * ATTACH aliases belonging to sources in *this* dataset.
   *
   * A SQLite or Postgres source is attached as its own catalog, and `customers.orders`
   * parses with the alias in the schema position. Those belong to the active dataset, so
   * treating them as foreign would block a user from reading their own connected
   * database through its real name.
   */
  ownAttachments: ReadonlySet<string> = new Set(),
): Promise<ScopeCheck> {
  const references = await extractTableReferences(conn, stripExplain(sql));

  if (references === null) {
    // Not serialisable. `json_serialize_sql` handles SELECT only, so EXPLAIN (after the
    // strip above), PRAGMA, SHOW and DESCRIBE land here even though the read-only guard
    // has already passed them as legitimate reads.
    //
    // Failing closed outright would block `DESCRIBE orders`, which is a perfectly normal
    // thing to run. So there is a conservative textual fallback for this narrow class:
    // refuse if the text names any schema that is not the active one. It is weaker than
    // the AST check and deliberately limited to statements the AST cannot see — these
    // have no meaningful string-literal complexity to hide a name in.
    assertNoForeignSchemaMentioned(sql, activeSchema, datasetName, schemaToDataset, ownAttachments);
    return { references: [], unqualified: [] };
  }

  const offending = references.filter((ref) => {
    if (ref.schema.length === 0) return false;
    if (ref.schema === activeSchema) return false;
    if (ownAttachments.has(ref.schema)) return false;
    return !ALWAYS_ALLOWED_SCHEMAS.has(ref.schema.toLowerCase());
  });

  if (offending.length > 0) {
    const named = offending
      .map((ref) => {
        const other = schemaToDataset.get(ref.schema);
        return other === undefined
          ? `${ref.schema}.${ref.table}`
          : `${ref.table} (in the "${other}" dataset)`;
      })
      .join(', ');

    throw new DateraError(
      'CROSS_DATASET_ACCESS',
      `This query reaches outside "${datasetName}": ${named}. ` +
        `Datasets are the boundary Datera guarantees — sources in different datasets cannot be joined. ` +
        `Move the sources into one dataset if they genuinely belong together.`,
      {
        sql,
        activeDataset: datasetName,
        offending: offending.map((r) => `${r.schema}.${r.table}`),
      },
    );
  }

  return {
    references,
    unqualified: references.filter((r) => r.schema.length === 0),
  };
}

/** `EXPLAIN SELECT …` is a read; serialise what it explains. */
function stripExplain(sql: string): string {
  return sql.replace(/^\s*EXPLAIN\s+(ANALYZE\s+)?/i, '');
}

/**
 * The fallback for statements DuckDB will not serialise.
 *
 * Conservative by construction: anything naming a schema other than the active one is
 * refused, including inside a string literal, which is where `PRAGMA table_info('x.y')`
 * hides its argument.
 */
function assertNoForeignSchemaMentioned(
  sql: string,
  activeSchema: string,
  datasetName: string,
  schemaToDataset: ReadonlyMap<string, string>,
  ownAttachments: ReadonlySet<string>,
): void {
  const lower = sql.toLowerCase();

  const foreign = [...schemaToDataset.keys(), CATALOG_SCHEMA].filter((schema) => {
    if (schema === activeSchema) return false;
    if (ownAttachments.has(schema)) return false;
    return new RegExp(`\\b${schema.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower);
  });

  if (foreign.length > 0) {
    throw new DateraError(
      'CROSS_DATASET_ACCESS',
      `This statement names ${foreign.join(', ')}, which is outside "${datasetName}".`,
      { sql, activeDataset: datasetName, offending: foreign },
    );
  }
}

/** Datera's own bookkeeping schema, never reachable through the user query path. */
const CATALOG_SCHEMA = '_datera';
