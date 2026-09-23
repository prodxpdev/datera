import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Unpack the DuckDB extensions a packaged build ships compressed.
 *
 * They travel gzipped because a .duckdb_extension is a Mach-O library with metadata
 * appended, which `codesign` refuses — see scripts/pack-extensions.mjs. Compressed they
 * are inert data inside the signed bundle; here they become files DuckDB can load.
 *
 * Synchronous on purpose: this runs before the engine opens, and making it async would
 * mean either blocking on a promise at startup anyway or inventing a "not ready yet"
 * state for the one thing everything else depends on.
 */
export function unpackExtensions(packedRoot: string, targetRoot: string): string {
  if (!existsSync(packedRoot)) return targetRoot;

  for (const source of gzFilesIn(packedRoot)) {
    const relative = source.slice(packedRoot.length + 1);
    const destination = join(targetRoot, relative.replace(/\.gz$/, ''));

    // Skip what is already there, so this costs one directory walk on every launch but
    // the write only once. Size is compared rather than existence: a half-written file
    // from an interrupted first run would otherwise be trusted forever.
    const expected = expectedSize(source);
    if (existsSync(destination) && statSync(destination).size === expected) continue;

    mkdirSync(dirname(destination), { recursive: true });

    // Written beside and renamed into place, because two windows opening at once would
    // otherwise be writing the same file — and a partially written extension is one
    // DuckDB fails to load with an error about the file rather than about this.
    const partial = `${destination}.${process.pid}.partial`;
    writeFileSync(partial, gunzipSync(readFileSync(source)));
    renameSync(partial, destination);
  }

  return targetRoot;
}

/**
 * The uncompressed size, from the gzip trailer's last four bytes.
 *
 * Cheaper than decompressing to find out, which is the whole point of checking before
 * doing the work.
 */
function expectedSize(path: string): number {
  const file = readFileSync(path);
  return file.length < 4 ? -1 : file.readUInt32LE(file.length - 4);
}

function gzFilesIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...gzFilesIn(path));
    else if (entry.name.endsWith('.gz')) found.push(path);
  }
  return found;
}
