/**
 * The DuckDB driver port.
 *
 * This is the seam that keeps invariant §1.7 true and makes the iPad path in spec §2a
 * reachable without a rewrite: `@datera/node-runtime` supplies a `@duckdb/node-api`
 * driver for desktop and server; a later webview host supplies a `duckdb-wasm` driver.
 * Nothing above this port knows which one it has.
 */

export type SqlParam = string | number | bigint | boolean | null;

export interface ResultColumn {
  readonly name: string;
  /** The DuckDB type name, verbatim — e.g. 'BIGINT', 'VARCHAR', 'TIMESTAMP'. */
  readonly type: string;
}

export interface ResultSet {
  readonly columns: readonly ResultColumn[];
  /** Rows as JSON-safe values. BIGINT arrives as a string to survive the IPC boundary intact. */
  readonly rows: readonly (readonly unknown[])[];
}

/**
 * What a statement *is*, decided by DuckDB's own parser rather than by pattern-matching
 * the text. The read-only guard depends on this being authoritative (spec §1.5:
 * deterministic where facts matter).
 */
export type StatementKind =
  | 'SELECT'
  | 'EXPLAIN'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'CREATE'
  | 'DROP'
  | 'ALTER'
  | 'ATTACH'
  | 'DETACH'
  | 'COPY'
  | 'COPY_DATABASE'
  | 'EXPORT'
  | 'LOAD'
  | 'SET'
  | 'TRANSACTION'
  | 'CALL'
  | 'PRAGMA'
  | 'ANALYZE'
  | 'VACUUM'
  | 'PREPARE'
  | 'EXECUTE'
  | 'MERGE_INTO'
  | 'RELATION'
  | 'OTHER';

/**
 * One statement's classification.
 *
 * `kind` is 'UNKNOWN' when DuckDB could parse the statement but not *bind* it — which
 * happens for a write against a view, or a SELECT against a missing table. Binding and
 * classification are different questions, and conflating them is how a guard ends up
 * reporting "Binder Error" where it meant "refused: DELETE".
 */
export interface StatementClassification {
  readonly kind: StatementKind | 'UNKNOWN';
  /** DuckDB's message when binding failed. Present only when `kind` is 'UNKNOWN'. */
  readonly bindError?: string | undefined;
}

export interface ClassificationResult {
  readonly statements: readonly StatementClassification[];
  /**
   * True when DuckDB's *parser* confirms the input is exactly one SELECT.
   *
   * Independent of binding, so it can vouch for a SELECT that references a table which
   * does not exist — letting that surface as the catalog error it is, rather than as a
   * spurious read-only violation.
   */
  readonly isSingleSelect: boolean;
}

export interface DuckDBConnectionPort {
  /** Execute. Callers that accept user SQL must pass it through the read-only guard first. */
  run(sql: string, params?: readonly SqlParam[]): Promise<ResultSet>;
  /**
   * Classify every statement in `sql` WITHOUT executing any of them.
   *
   * Returns one entry per statement, so `SELECT 1; DROP TABLE t;` yields two and the DROP
   * cannot be smuggled past a guard that only inspects the first.
   *
   * Throws `SQL_ERROR` when the text cannot be parsed at all — a syntax error is a broken
   * query, not an attempted write, and must not be reported as one.
   */
  classify(sql: string): Promise<ClassificationResult>;
  close(): Promise<void>;
}

export interface DuckDBHandlePort {
  connect(): Promise<DuckDBConnectionPort>;
  close(): Promise<void>;
}

export interface DuckDBOpenOptions {
  /** Filesystem path to the database, or ':memory:'. */
  readonly path: string;
  /** DuckDB configuration applied at instance creation. */
  readonly config?: Readonly<Record<string, string>>;
}

export interface DuckDBDriverPort {
  /** Identifies the driver in traces — e.g. 'duckdb-node-api'. */
  readonly name: string;
  open(options: DuckDBOpenOptions): Promise<DuckDBHandlePort>;
}
