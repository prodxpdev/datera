import type { Engine } from '../engine/engine.js';
import { quoteIdent } from '../engine/sql.js';
import type { DuckDBConnectionPort } from '../ports/duckdb.js';
import type { SourceSchema } from '../schema/introspect.js';
import { extractTableReferences } from './scope.js';

/**
 * "What it touched" — the physical drill-down (spec §5).
 *
 * For a single source: which columns were read, how many rows matched, and the filter that
 * matched them. For a join: the tables and columns with each column's *role* — join key,
 * filter, group-by, aggregate — and the join path.
 *
 * Everything here is derived from DuckDB's own parse tree and its query plan, never from
 * the model (§1.5). The model wrote the SQL; what that SQL actually did is a fact, and
 * facts are measured.
 */

export type ColumnRoleInQuery = 'join' | 'filter' | 'group' | 'aggregate' | 'select';

export interface TouchedColumn {
  readonly column: string;
  readonly role: ColumnRoleInQuery | null;
}

export interface TouchedTable {
  readonly table: string;
  readonly columns: readonly TouchedColumn[];
}

export interface TouchedSummary {
  /** 'sheet' when one source was read, 'join' when several were. */
  readonly shape: 'sheet' | 'join' | 'none';
  readonly tables: readonly TouchedTable[];
  /** The WHERE clause, verbatim — the thing that explains which rows matched. */
  readonly filter: string | null;
  /** e.g. 'orders.customer_id → customers.id'. */
  readonly joinPath: readonly string[];
  /** Rows the query returned. */
  readonly rowsReturned: number;
  /** Rows in the source(s) before filtering, when one source was read. */
  readonly rowsScanned: number | null;
}

/**
 * Work out what a statement touched.
 *
 * Roles come from where a column appears in the parse tree: a column inside the ON
 * clause is a join key, one inside WHERE is a filter, and so on. That is more honest than
 * matching names against the SQL text, which cannot tell `orders.id` in a join from
 * `orders.id` in a projection — and the whole point of the drill-down is showing the
 * difference.
 */
export async function summariseTouched(
  engine: Engine,
  sql: string,
  schemas: readonly SourceSchema[],
  rowsReturned: number,
): Promise<TouchedSummary> {
  const conn: DuckDBConnectionPort = engine.classificationConnection();
  const references = (await extractTableReferences(conn, sql)) ?? [];

  const known = new Map(schemas.map((s) => [s.sourceName.toLowerCase(), s]));
  const touchedNames = [
    ...new Set(
      references
        .map((r) => r.table)
        .filter((t) => known.has(t.toLowerCase())),
    ),
  ];

  if (touchedNames.length === 0) {
    return { shape: 'none', tables: [], filter: null, joinPath: [], rowsReturned, rowsScanned: null };
  }

  const ast = await parseAst(conn, sql);
  const roles = ast === null ? new Map<string, ColumnRoleInQuery>() : collectColumnRoles(ast);

  const tables: TouchedTable[] = touchedNames.map((name) => {
    const schema = known.get(name.toLowerCase());
    const columns = (schema?.columns ?? [])
      .map((c) => ({ column: c.name, role: roles.get(c.name.toLowerCase()) ?? null }))
      // Columns the query never mentioned are still listed, with a null role: "which
      // columns were ignored" is as informative as which were read.
      .map((c) => ({ column: c.column, role: c.role }));
    return { table: name, columns };
  });

  const rowsScanned =
    touchedNames.length === 1 ? (known.get(touchedNames[0]!.toLowerCase())?.rowCount ?? null) : null;

  return {
    shape: touchedNames.length === 1 ? 'sheet' : 'join',
    tables,
    filter: ast === null ? null : extractWhereText(sql),
    joinPath: ast === null ? [] : collectJoinPath(ast),
    rowsReturned,
    rowsScanned,
  };
}

async function parseAst(conn: DuckDBConnectionPort, sql: string): Promise<unknown | null> {
  try {
    const result = await conn.run('SELECT json_serialize_sql(?::VARCHAR)', [sql]);
    const raw = result.rows[0]?.[0];
    if (typeof raw !== 'string') return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && (parsed as { error?: unknown }).error === true) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Walk the tree, recording which syntactic position each column appeared in.
 *
 * When a column appears in more than one position the stronger role wins — a join key
 * that is also selected is still a join key, because that is the thing worth knowing.
 */
function collectColumnRoles(ast: unknown): Map<string, ColumnRoleInQuery> {
  const roles = new Map<string, ColumnRoleInQuery>();
  const strength: Record<ColumnRoleInQuery, number> = {
    join: 5, group: 4, aggregate: 3, filter: 2, select: 1,
  };

  const record = (name: string, role: ColumnRoleInQuery): void => {
    const key = name.toLowerCase();
    const existing = roles.get(key);
    if (existing === undefined || strength[role] > strength[existing]) roles.set(key, role);
  };

  const columnsUnder = (node: unknown, out: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const child of node) columnsUnder(child, out);
      return out;
    }
    if (typeof node !== 'object' || node === null) return out;
    const rec = node as Record<string, unknown>;
    if (rec['class'] === 'COLUMN_REF' && Array.isArray(rec['column_names'])) {
      const names = rec['column_names'] as unknown[];
      const last = names[names.length - 1];
      if (typeof last === 'string') out.push(last);
    }
    for (const value of Object.values(rec)) columnsUnder(value, out);
    return out;
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const rec = node as Record<string, unknown>;

    if (rec['type'] === 'JOIN' && rec['condition'] !== undefined) {
      for (const name of columnsUnder(rec['condition'])) record(name, 'join');
    }
    if (rec['where_clause'] !== undefined && rec['where_clause'] !== null) {
      for (const name of columnsUnder(rec['where_clause'])) record(name, 'filter');
    }
    if (Array.isArray(rec['group_expressions'])) {
      for (const name of columnsUnder(rec['group_expressions'])) record(name, 'group');
    }
    if (rec['class'] === 'FUNCTION' && isAggregate(rec['function_name'])) {
      for (const name of columnsUnder(rec['children'])) record(name, 'aggregate');
    }
    if (Array.isArray(rec['select_list'])) {
      for (const name of columnsUnder(rec['select_list'])) record(name, 'select');
    }

    for (const value of Object.values(rec)) walk(value);
  };

  walk(ast);
  return roles;
}

const AGGREGATES = new Set(['sum', 'count', 'avg', 'min', 'max', 'median', 'stddev', 'total']);

function isAggregate(name: unknown): boolean {
  return typeof name === 'string' && AGGREGATES.has(name.toLowerCase());
}

function collectJoinPath(ast: unknown): readonly string[] {
  const paths: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const rec = node as Record<string, unknown>;

    if (rec['type'] === 'JOIN' && rec['condition'] !== undefined) {
      const refs: string[] = [];
      const gather = (n: unknown): void => {
        if (Array.isArray(n)) {
          for (const c of n) gather(c);
          return;
        }
        if (typeof n !== 'object' || n === null) return;
        const r = n as Record<string, unknown>;
        if (r['class'] === 'COLUMN_REF' && Array.isArray(r['column_names'])) {
          refs.push((r['column_names'] as unknown[]).filter((x) => typeof x === 'string').join('.'));
        }
        for (const v of Object.values(r)) gather(v);
      };
      gather(rec['condition']);
      if (refs.length >= 2) paths.push(`${refs[0]} → ${refs[1]}`);
    }

    for (const value of Object.values(rec)) walk(value);
  };

  walk(ast);
  return paths;
}

/** The WHERE clause as the user wrote it — more readable than reconstructing from the AST. */
function extractWhereText(sql: string): string | null {
  const match = /\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i.exec(sql);
  const body = match?.[1]?.trim();
  return body === undefined || body.length === 0 ? null : body;
}

/** Count how many rows a filter matches, without returning them. */
export async function countMatching(
  engine: Engine,
  sourceName: string,
  filter: string,
  monotonicMs: () => number,
): Promise<number | null> {
  try {
    const result = await engine.executeUserQuery(
      `SELECT count(*) FROM ${quoteIdent(sourceName)} WHERE ${filter}`,
      monotonicMs,
    );
    return Number(result.resultSet.rows[0]?.[0] ?? 0);
  } catch {
    return null;
  }
}
