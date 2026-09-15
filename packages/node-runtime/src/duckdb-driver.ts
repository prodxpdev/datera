import { DuckDBInstance, StatementType } from '@duckdb/node-api';
import {
  DateraError,
  type ClassificationResult,
  type DuckDBConnectionPort,
  type DuckDBDriverPort,
  type DuckDBHandlePort,
  type DuckDBOpenOptions,
  type ResultSet,
  type SqlParam,
  type StatementClassification,
  type StatementKind,
} from '@datera/core';

/** DuckDB's numeric StatementType → the core's StatementKind. */
const STATEMENT_KINDS: Readonly<Record<number, StatementKind>> = {
  [StatementType.SELECT]: 'SELECT',
  [StatementType.INSERT]: 'INSERT',
  [StatementType.UPDATE]: 'UPDATE',
  [StatementType.EXPLAIN]: 'EXPLAIN',
  [StatementType.DELETE]: 'DELETE',
  [StatementType.PREPARE]: 'PREPARE',
  [StatementType.CREATE]: 'CREATE',
  [StatementType.EXECUTE]: 'EXECUTE',
  [StatementType.ALTER]: 'ALTER',
  [StatementType.TRANSACTION]: 'TRANSACTION',
  [StatementType.COPY]: 'COPY',
  [StatementType.ANALYZE]: 'ANALYZE',
  [StatementType.CREATE_FUNC]: 'CREATE',
  [StatementType.DROP]: 'DROP',
  [StatementType.EXPORT]: 'EXPORT',
  [StatementType.PRAGMA]: 'PRAGMA',
  [StatementType.VACUUM]: 'VACUUM',
  [StatementType.CALL]: 'CALL',
  [StatementType.SET]: 'SET',
  [StatementType.LOAD]: 'LOAD',
  [StatementType.RELATION]: 'RELATION',
  [StatementType.ATTACH]: 'ATTACH',
  [StatementType.DETACH]: 'DETACH',
  [StatementType.COPY_DATABASE]: 'COPY_DATABASE',
  [StatementType.MERGE_INTO]: 'MERGE_INTO',
};

function toKind(type: number): StatementKind {
  return STATEMENT_KINDS[type] ?? 'OTHER';
}

/**
 * Convert a DuckDB value into something that survives JSON and an IPC hop.
 *
 * BIGINT arrives as a JavaScript `bigint`, which `JSON.stringify` throws on and which
 * `structuredClone` would silently widen through a renderer boundary. Stringifying it
 * keeps the exact value — losing precision on an id column is exactly the class of bug
 * invariant §1.5 exists to prevent.
 */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    // DuckDB's richer values (DECIMAL, INTERVAL, STRUCT, LIST…) expose a toString that
    // matches what the DuckDB CLI prints. Showing the user the same text DuckDB shows is
    // the honest rendering.
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== null && proto !== Object.prototype) return String(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

class NodeConnection implements DuckDBConnectionPort {
  constructor(private readonly conn: Awaited<ReturnType<DuckDBInstance['connect']>>) {}

  async run(sql: string, params?: readonly SqlParam[]): Promise<ResultSet> {
    const reader =
      params === undefined || params.length === 0
        ? await this.conn.runAndReadAll(sql)
        : await this.conn.runAndReadAll(sql, [...params] as never);

    const names = reader.columnNames();
    const types = reader.columnTypes().map((t) => String(t));
    const columns = names.map((name, i) => ({ name, type: types[i] ?? 'UNKNOWN' }));
    const rows = reader.getRows().map((row) => row.map(toJsonSafe));

    return { columns, rows };
  }

  /**
   * Classify without executing.
   *
   * `extractStatements` splits the text with DuckDB's parser, so a batch such as
   * `SELECT 1; DROP TABLE t;` reports two statements and the DROP cannot hide behind the
   * SELECT. `prepare` plans but does not run, so nothing is executed here.
   *
   * `prepare` also *binds*, which fails for a write against a view (`DELETE FROM a_view`)
   * and for a read against a missing table. Those two must not be conflated, so a bind
   * failure yields 'UNKNOWN' plus DuckDB's message, and `isSingleSelect` is computed
   * separately from the parser alone.
   */
  async classify(sql: string): Promise<ClassificationResult> {
    let extracted;
    try {
      extracted = await this.conn.extractStatements(sql);
    } catch (e) {
      // Parse failure: broken SQL, not an attempted write.
      throw new DateraError('SQL_ERROR', e instanceof Error ? e.message : String(e), { sql });
    }

    const statements: StatementClassification[] = [];
    for (let i = 0; i < extracted.count; i += 1) {
      try {
        const prepared = await extracted.prepare(i);
        statements.push({ kind: toKind(prepared.statementType) });
      } catch (e) {
        statements.push({
          kind: 'UNKNOWN',
          bindError: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { statements, isSingleSelect: await this.parserVouchesSingleSelect(sql) };
  }

  /**
   * Ask DuckDB's parser — not its binder — whether this is exactly one SELECT.
   *
   * `json_serialize_sql` succeeds only for a single SELECT statement and errors for
   * everything else, including multi-statement batches. That makes it a precise positive
   * signal and it never executes anything.
   */
  private async parserVouchesSingleSelect(sql: string): Promise<boolean> {
    try {
      const reader = await this.conn.runAndReadAll('SELECT json_serialize_sql(?::VARCHAR)', [sql]);
      const raw = reader.getRowsJson()[0]?.[0];
      if (typeof raw !== 'string') return false;
      const parsed = JSON.parse(raw) as {
        error?: boolean;
        statements?: readonly { node?: { type?: string } }[];
      };
      if (parsed.error === true) return false;
      const nodes = parsed.statements ?? [];
      return nodes.length === 1 && nodes[0]?.node?.type === 'SELECT_NODE';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.conn.closeSync();
  }
}

class NodeHandle implements DuckDBHandlePort {
  constructor(private readonly instance: DuckDBInstance) {}

  async connect(): Promise<DuckDBConnectionPort> {
    return new NodeConnection(await this.instance.connect());
  }

  async close(): Promise<void> {
    this.instance.closeSync();
  }
}

/**
 * The DuckDB driver for Node hosts: the Electron main process, the `datera` CLI, and
 * `datera-server`. A later iPad webview host supplies a `duckdb-wasm` driver against the
 * same port without the core changing (spec §2a).
 */
export class NodeDuckDBDriver implements DuckDBDriverPort {
  readonly name = 'duckdb-node-api';

  async open(options: DuckDBOpenOptions): Promise<DuckDBHandlePort> {
    const instance = await DuckDBInstance.create(options.path, { ...options.config });
    return new NodeHandle(instance);
  }
}

export function nodeDuckDBDriver(): DuckDBDriverPort {
  return new NodeDuckDBDriver();
}
