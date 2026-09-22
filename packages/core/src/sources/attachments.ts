import { DateraError } from '../errors.js';
import type { Engine } from '../engine/engine.js';
import { quoteIdent, quoteLiteral } from '../engine/sql.js';
import type { DatabaseSourceKind } from './types.js';

/**
 * Connection parameters for an attached database, minus the credential.
 *
 * The password is never a field here. It lives in the SecretStore and is fetched only at
 * the moment of ATTACH (decision D-06), so it cannot end up in the catalog, in a log
 * line, or in a transparency payload by accident.
 */
export interface DatabaseConnectionParams {
  readonly kind: DatabaseSourceKind;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly database: string;
  readonly user?: string | undefined;
  /** For SQLite: the file path. */
  readonly path?: string | undefined;
}

export function redactedOrigin(params: DatabaseConnectionParams): string {
  if (params.kind === 'sqlite') return params.path ?? params.database;
  const auth = params.user === undefined ? '' : `${params.user}@`;
  const port = params.port === undefined ? '' : `:${params.port}`;
  return `${params.kind}://${auth}${params.host ?? 'localhost'}${port}/${params.database}`;
}

export function defaultPort(kind: DatabaseSourceKind): number | undefined {
  switch (kind) {
    case 'postgres':
      return 5432;
    case 'mysql':
      return 3306;
    case 'sqlite':
      return undefined;
  }
}

/**
 * Build the ATTACH statement.
 *
 * Every branch sets READ_ONLY. That is invariant §1.1 at the deepest level available to
 * us: even if something above this layer had a bug, DuckDB itself will refuse a write to
 * the attached catalog. The guard in `read-only.ts` stops the statement; this stops the
 * engine. Two independent mechanisms, because one is how a source gets mutated.
 */
export function buildAttachStatement(
  params: DatabaseConnectionParams,
  alias: string,
  password: string | null,
): string {
  const quotedAlias = quoteIdent(alias);

  if (params.kind === 'sqlite') {
    const path = params.path;
    if (path === undefined) {
      throw new DateraError('INVALID_ARGUMENT', 'A SQLite source needs a file path', {});
    }
    return `ATTACH ${quoteLiteral(path)} AS ${quotedAlias} (TYPE sqlite, READ_ONLY)`;
  }

  const parts: string[] = [];
  if (params.host !== undefined) parts.push(`host=${params.host}`);
  if (params.port !== undefined) parts.push(`port=${params.port}`);
  if (params.user !== undefined) parts.push(`user=${params.user}`);
  if (password !== null && password.length > 0) parts.push(`password=${password}`);

  if (params.kind === 'postgres') {
    parts.push(`dbname=${params.database}`);
    return `ATTACH ${quoteLiteral(parts.join(' '))} AS ${quotedAlias} (TYPE postgres, READ_ONLY)`;
  }

  parts.push(`database=${params.database}`);
  return `ATTACH ${quoteLiteral(parts.join(' '))} AS ${quotedAlias} (TYPE mysql, READ_ONLY)`;
}

export async function isAttached(engine: Engine, alias: string): Promise<boolean> {
  const result = await engine.executeInternal(
    'SELECT count(*) FROM duckdb_databases() WHERE database_name = ?',
    [alias],
  );
  return Number(result.rows[0]?.[0] ?? 0) > 0;
}

/**
 * Strip anything credential-shaped out of text before it is allowed into an error.
 *
 * DuckDB's ATTACH failures quote the connection string back at you, password included.
 * That message then flows into an error message, a log line, and a UI toast — so the
 * credential has to be removed at the boundary rather than trusted not to travel.
 *
 * Belt and braces alongside not passing the statement into the error details: the leak
 * path here was the *underlying* message, not our own.
 */
export function redactCredentials(text: string, password: string | null): string {
  let out = text;
  if (password !== null && password.length > 0) {
    out = out.split(password).join('«redacted»');
  }
  // Also catch the shape generically, so a credential we were not given (one embedded in a
  // DSN, say) does not slip through on some future path.
  out = out.replace(/\b(password|pwd|passwd)\s*=\s*[^\s'";]+/gi, '$1=«redacted»');
  return out;
}

export async function attachDatabase(
  engine: Engine,
  params: DatabaseConnectionParams,
  alias: string,
  password: string | null,
): Promise<void> {
  if (await isAttached(engine, alias)) return;
  try {
    await engine.executeInternal(buildAttachStatement(params, alias, password));
  } catch (e) {
    // Neither the statement nor DuckDB's raw message may reach the error: both contain the
    // password. The cause is redacted, not dropped, so the failure stays diagnosable.
    const raw = e instanceof Error ? e.message : String(e);
    throw new DateraError(
      'CONNECTION_FAILED',
      `Could not connect to ${redactedOrigin(params)}: ${redactCredentials(raw, password)}`,
      {
        kind: params.kind,
        origin: redactedOrigin(params),
        cause: redactCredentials(raw, password),
      },
    );
  }
}

/** Tables visible in an attached database, excluding system schemas. */
export async function listAttachedTables(engine: Engine, alias: string): Promise<readonly string[]> {
  const result = await engine.executeInternal(
    `SELECT table_name FROM duckdb_tables() WHERE database_name = ? ORDER BY table_name`,
    [alias],
  );
  return result.rows.map((row) => String(row[0]));
}

export async function listAttachedViews(engine: Engine, alias: string): Promise<readonly string[]> {
  const result = await engine.executeInternal(
    `SELECT view_name FROM duckdb_views() WHERE database_name = ? AND NOT internal ORDER BY view_name`,
    [alias],
  );
  return result.rows.map((row) => String(row[0]));
}
