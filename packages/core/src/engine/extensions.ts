import { asDateraError, DateraError } from '../errors.js';
import type { DuckDBConnectionPort } from '../ports/duckdb.js';
import type { LoggerPort } from '../ports/logger.js';

/**
 * Extensions the Phase 1 format set needs, beyond what DuckDB links statically
 * (json, parquet, icu and core_functions are already in the binary).
 */
export const REQUIRED_EXTENSIONS = [
  'excel', 'sqlite_scanner', 'postgres_scanner', 'mysql_scanner',
  // Optional: HNSW indexing for the semantic path. Cosine similarity is a core DuckDB
  // function, so its absence slows large corpora rather than breaking anything.
  'vss',
] as const;
export type RequiredExtension = (typeof REQUIRED_EXTENSIONS)[number];

export interface ExtensionStatus {
  readonly name: string;
  readonly loaded: boolean;
  readonly error?: string;
}

/**
 * Load the required extensions from the *staged* extension directory.
 *
 * Deliberately LOAD and never INSTALL. Datera is a local-first tool that promises nothing
 * leaves the machine (invariant §1.6); an extension silently downloaded the first time
 * somebody opens a spreadsheet breaks that promise at the worst possible moment — offline,
 * on a classroom network, mid-demo. Extensions are staged once at install time by
 * `scripts/stage-extensions.mjs`, and the engine is configured with
 * `autoinstall_known_extensions=false` / `autoload_known_extensions=false` so DuckDB
 * cannot reach the network on its own either.
 */
export async function loadRequiredExtensions(
  conn: DuckDBConnectionPort,
  logger: LoggerPort,
  extensions: readonly string[] = REQUIRED_EXTENSIONS,
): Promise<readonly ExtensionStatus[]> {
  const statuses: ExtensionStatus[] = [];

  for (const name of extensions) {
    try {
      await conn.run(`LOAD ${name}`);
      statuses.push({ name, loaded: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Not fatal on its own: a user with only CSV files does not need sqlite_scanner.
      // The failure surfaces when a source of that kind is actually connected.
      logger.log('warn', 'DuckDB extension unavailable', { extension: name, error: message });
      statuses.push({ name, loaded: false, error: message });
    }
  }

  return statuses;
}

/** Throw a clear, actionable error when a source needs an extension that is not loaded. */
export function assertExtensionLoaded(
  statuses: readonly ExtensionStatus[],
  name: RequiredExtension,
  neededFor: string,
): void {
  const status = statuses.find((s) => s.name === name);
  if (status?.loaded === true) return;

  throw new DateraError(
    'EXTENSION_UNAVAILABLE',
    `The DuckDB "${name}" extension is required for ${neededFor} but is not loaded. ` +
      `Run "pnpm run stage-extensions" to stage it locally — Datera never downloads extensions at query time.`,
    { extension: name, neededFor, underlying: status?.error ?? 'not attempted' },
  );
}

export async function readLoadedExtensions(conn: DuckDBConnectionPort): Promise<readonly ExtensionStatus[]> {
  try {
    const result = await conn.run(
      'SELECT extension_name, loaded FROM duckdb_extensions() ORDER BY extension_name',
    );
    return result.rows.map((row) => ({ name: String(row[0]), loaded: row[1] === true }));
  } catch (e) {
    throw asDateraError(e, 'SQL_ERROR', 'Could not enumerate DuckDB extensions');
  }
}
