import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const VENDOR_SEGMENTS = ['vendor', 'duckdb-extensions'] as const;

/**
 * Where pre-staged DuckDB extensions live.
 *
 * Resolution order:
 *  1. `DATERA_EXTENSION_DIR` — how a container, CI, or a test pins it explicitly.
 *  2. `~/.datera/duckdb-extensions` — the installed-app location.
 *  3. The nearest `vendor/duckdb-extensions` at or above `startDir` — the dev-tree case.
 *
 * Step 3 searches *upward* rather than assuming a fixed depth. In a pnpm workspace the
 * staged directory sits at the repository root while the app that needs it lives at
 * `apps/desktop`, so a fixed `<appRoot>/vendor` guess silently misses it — and the failure
 * is quiet and late: extensions do not load, and `.xlsx` and SQLite report
 * EXTENSION_UNAVAILABLE much later, far from the cause.
 *
 * Datera never installs an extension at query time (see core's engine/extensions.ts), so
 * getting this path wrong means those formats are simply unavailable rather than silently
 * downloaded — which is the right failure, but only if the path is usually right.
 */
export function resolveExtensionDirectory(startDir?: string): string {
  const fromEnv = process.env['DATERA_EXTENSION_DIR'];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);

  const installed = join(homedir(), '.datera', ...VENDOR_SEGMENTS.slice(1));
  if (existsSync(installed)) return installed;

  const found = startDir === undefined ? null : findUpwards(startDir);
  if (found !== null) return found;

  return installed;
}

/** Walk up from `startDir` looking for `vendor/duckdb-extensions`. */
function findUpwards(startDir: string): string | null {
  let current = resolve(startDir);

  // Bounded rather than `while (true)`: a symlink loop or an odd mount should not hang
  // application startup.
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(current, ...VENDOR_SEGMENTS);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
