#!/usr/bin/env node
/**
 * Compress the staged DuckDB extensions for packaging.
 *
 * A .duckdb_extension is a Mach-O library with DuckDB's own metadata appended, and that
 * footer breaks Mach-O strict validation — so `codesign` refuses them outright, even
 * ad-hoc. Anything inside a signed .app gets signed, so shipping them as-is makes the
 * build unsignable, and therefore unnotarizable, and therefore something macOS warns
 * about on every machine that is not this one.
 *
 * Gzipped they are opaque data: nothing to sign, nothing for the notary service to object
 * to. The app unpacks them on first run into its data directory, where they are ordinary
 * files DuckDB can load.
 *
 * node:zlib rather than a zip or tar tool, because this has to run identically on the
 * three platforms that build releases, and only Node is guaranteed to be on all of them.
 */
import { gzipSync } from 'node:zlib';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor/duckdb-extensions');
const target = join(root, 'apps/desktop/build/extensions-packed');

await rm(target, { recursive: true, force: true });

let packed = 0;
let before = 0;
let after = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }

    const contents = await readFile(path);
    const compressed = gzipSync(contents, { level: 9 });
    const destination = join(target, `${relative(source, path)}.gz`);

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, compressed);

    packed += 1;
    before += contents.length;
    after += compressed.length;
  }
}

await walk(source);

const mb = (n) => (n / 1024 ** 2).toFixed(0);
console.log(`Packed ${packed} extension files: ${mb(before)} MB -> ${mb(after)} MB.`);
