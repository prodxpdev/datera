import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where pre-staged DuckDB extensions live.
 *
 * Resolution order:
 *  1. `DATERA_EXTENSION_DIR` — how a container or CI pins it.
 *  2. `<repo>/vendor/duckdb-extensions` — populated by `pnpm run stage-extensions`.
 *  3. `~/.datera/duckdb-extensions` — the installed-app location.
 *
 * Datera never installs an extension at query time (see core's engine/extensions.ts), so
 * this directory must be populated ahead of time or the affected formats are unavailable
 * with a clear error rather than a silent download.
 */
export function resolveExtensionDirectory(repoRoot?: string): string {
  const fromEnv = process.env['DATERA_EXTENSION_DIR'];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  if (repoRoot !== undefined) return join(repoRoot, 'vendor', 'duckdb-extensions');
  return join(homedir(), '.datera', 'duckdb-extensions');
}
