import { asDateraError } from '../errors.js';
import type {
  DuckDBConnectionPort,
  DuckDBDriverPort,
  DuckDBHandlePort,
  ResultSet,
  SqlParam,
} from '../ports/duckdb.js';
import type { LoggerPort } from '../ports/logger.js';
import { assertReadOnlySql, type ReadOnlyCheck } from './read-only.js';
import { loadRequiredExtensions, type ExtensionStatus } from './extensions.js';

export interface EngineOpenOptions {
  readonly driver: DuckDBDriverPort;
  readonly logger: LoggerPort;
  readonly databasePath: string;
  /**
   * Directory holding pre-staged DuckDB extensions. Required in practice — without it
   * DuckDB falls back to its own home directory, which may be unpopulated.
   */
  readonly extensionDirectory?: string | undefined;
  readonly extraConfig?: Readonly<Record<string, string>> | undefined;
}

export interface UserQueryResult {
  readonly resultSet: ResultSet;
  readonly check: ReadOnlyCheck;
  readonly durationMs: number;
}

/**
 * Owns the DuckDB instance and the single privileged connection.
 *
 * Two execution paths exist, and the distinction is the whole point:
 *
 *  - `executeInternal` runs Datera's own statements (CREATE SCHEMA, CREATE VIEW, ATTACH).
 *    These write to the *workspace*, never to a source.
 *  - `executeUserQuery` runs anything that came from outside — a user, and later a model.
 *    It always passes the read-only guard first.
 *
 * Collapsing these into one method is how invariant §1.1 gets lost six months from now,
 * so they are separate names with separate doc comments rather than a boolean flag.
 */
export class Engine {
  private constructor(
    private readonly handle: DuckDBHandlePort,
    private readonly conn: DuckDBConnectionPort,
    private readonly logger: LoggerPort,
    readonly driverName: string,
    readonly duckdbVersion: string,
    readonly extensions: readonly ExtensionStatus[],
  ) {}

  static async open(options: EngineOpenOptions): Promise<Engine> {
    const config: Record<string, string> = {
      // Nothing is fetched at query time. See engine/extensions.ts for why.
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      ...(options.extensionDirectory !== undefined
        ? { extension_directory: options.extensionDirectory }
        : {}),
      ...(options.extraConfig ?? {}),
    };

    let handle: DuckDBHandlePort;
    try {
      handle = await options.driver.open({ path: options.databasePath, config });
    } catch (e) {
      throw asDateraError(e, 'CONNECTION_FAILED', 'Could not open the workspace database', {
        databasePath: options.databasePath,
      });
    }

    const conn = await handle.connect();
    const versionResult = await conn.run('SELECT version()');
    const version = String(versionResult.rows[0]?.[0] ?? 'unknown');
    const extensions = await loadRequiredExtensions(conn, options.logger);

    options.logger.log('info', 'DuckDB engine opened', {
      driver: options.driver.name,
      duckdbVersion: version,
      extensionsLoaded: extensions.filter((x) => x.loaded).map((x) => x.name),
    });

    return new Engine(handle, conn, options.logger, options.driver.name, version, extensions);
  }

  /**
   * Run one of Datera's own statements. Not for user or model input — those go through
   * `executeUserQuery`, which enforces invariant §1.1.
   */
  async executeInternal(sql: string, params?: readonly SqlParam[]): Promise<ResultSet> {
    try {
      return await this.conn.run(sql, params);
    } catch (e) {
      throw asDateraError(e, 'SQL_ERROR', 'Internal statement failed', { sql });
    }
  }

  /**
   * Run SQL that came from outside Datera. Guarded: anything that is not a single
   * SELECT or EXPLAIN is refused before DuckDB ever sees it as an executable statement.
   */
  async executeUserQuery(sql: string, monotonicMs: () => number): Promise<UserQueryResult> {
    const check = await assertReadOnlySql(this.conn, sql);
    const started = monotonicMs();
    try {
      const resultSet = await this.conn.run(check.sql);
      return { resultSet, check, durationMs: monotonicMs() - started };
    } catch (e) {
      throw asDateraError(e, 'SQL_ERROR', 'Query failed', { sql: check.sql });
    }
  }

  /**
   * The connection, exposed only so the read-only guard can *classify* statements.
   *
   * Narrow on purpose. Callers that need to run something go through
   * `executeUserQuery`, which guards first; this exists because classification needs a
   * connection and handing the whole engine around would make the guarded path optional.
   */
  classificationConnection(): DuckDBConnectionPort {
    return this.conn;
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.handle.close();
    this.logger.log('debug', 'DuckDB engine closed', {});
  }
}
