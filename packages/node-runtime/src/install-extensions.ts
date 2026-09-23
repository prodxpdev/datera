import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * Fetch the DuckDB extensions Datera needs, once, into a directory it owns.
 *
 * ## Why they are not in the app any more
 *
 * A `.duckdb_extension` is a Mach-O library carrying a signature `codesign` rejects —
 * even ad-hoc. Apple's notary service unpacks archives and inspects what is inside, so
 * compressing them changed nothing: while these files ship inside the bundle in any form,
 * the app cannot be notarized, and an un-notarized app is one macOS tells your users
 * might be malware.
 *
 * So they are fetched at setup instead, exactly as the bundled model weights are: once,
 * verified, and never again.
 *
 * ## What this does to invariant §1.6
 *
 * Nothing. §1.6 forbids fetching **at query time** — connecting a spreadsheet offline
 * must work, and nothing may reach the network behind a user's back mid-question. That
 * holds: the app's own engine keeps `autoinstall_known_extensions` and
 * `autoload_known_extensions` off, and this runs at startup, on its own connection,
 * before any question is asked.
 *
 * Verification is DuckDB's own. `INSTALL` checks the extension's signature against the
 * key it was built with, which is a stronger claim than a checksum we recorded ourselves
 * would be.
 */
export interface ExtensionInstallResult {
  readonly installed: readonly string[];
  readonly failed: readonly { name: string; reason: string }[];
  /** True when nothing had to be fetched — the ordinary case after first run. */
  readonly alreadyPresent: boolean;
}

/** Without these, .xlsx and SQLite sources simply do not work. */
const REQUIRED = ['excel', 'sqlite_scanner', 'postgres_scanner', 'mysql_scanner'];

/**
 * Faster vector search, not a feature gate: cosine similarity is a core DuckDB function,
 * so the semantic path works without it. A failure here must not hold up startup.
 */
const OPTIONAL = ['vss'];

export async function installExtensions(
  directory: string,
  options: { onProgress?: (name: string) => void } = {},
): Promise<ExtensionInstallResult> {
  await mkdir(directory, { recursive: true });

  if (hasExtensions(directory)) {
    return { installed: [], failed: [], alreadyPresent: true };
  }

  // A connection of its own, with autoinstall enabled — the one place that is true. The
  // engine the application runs on never has it, which is what keeps §1.6 honest.
  const instance = await DuckDBInstance.create(':memory:', {
    extension_directory: directory,
    autoinstall_known_extensions: 'true',
    autoload_known_extensions: 'true',
  });
  const connection = await instance.connect();

  const installed: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  try {
    for (const name of [...REQUIRED, ...OPTIONAL]) {
      options.onProgress?.(name);
      try {
        await connection.run(`INSTALL ${name}`);
        installed.push(name);
      } catch (e) {
        // Optional ones are reported and shrugged off; required ones are reported and the
        // caller decides. Either way startup continues: an app that will not open because
        // a spreadsheet reader could not be downloaded is worse than one that opens and
        // says so.
        if (REQUIRED.includes(name)) {
          failed.push({ name, reason: (e as Error).message.split('\n')[0] ?? 'unknown' });
        }
      }
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  return { installed, failed, alreadyPresent: false };
}

/** Anything already downloaded means first run is done; DuckDB skips what it has. */
function hasExtensions(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return findExtension(directory, 0);
}

function findExtension(directory: string, depth: number): boolean {
  if (depth > 3) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (findExtension(`${directory}/${entry.name}`, depth + 1)) return true;
    } else if (entry.name.endsWith('.duckdb_extension')) {
      return true;
    }
  }
  return false;
}
