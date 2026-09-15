#!/usr/bin/env node
/**
 * Stage the DuckDB extensions Datera needs into vendor/duckdb-extensions.
 *
 * This is the ONE place Datera is allowed to reach the network for an extension, and it
 * runs at install time, not at query time. Everything afterwards LOADs from this
 * directory with autoinstall/autoload disabled, so connecting a spreadsheet offline
 * works and nothing is fetched behind a user's back (invariant §1.6).
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['excel', 'sqlite_scanner', 'postgres_scanner', 'mysql_scanner'];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.DATERA_EXTENSION_DIR
  ? resolve(process.env.DATERA_EXTENSION_DIR)
  : join(repoRoot, 'vendor', 'duckdb-extensions');

await mkdir(target, { recursive: true });

const instance = await DuckDBInstance.create(':memory:', { extension_directory: target });
const conn = await instance.connect();

const version = (await conn.runAndReadAll('SELECT version()')).getRowsJson()[0][0];
console.log(`Staging DuckDB ${version} extensions into ${target}`);

let failed = 0;
for (const name of REQUIRED) {
  try {
    await conn.run(`INSTALL ${name}`);
    await conn.run(`LOAD ${name}`);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

conn.closeSync();
instance.closeSync();

if (failed > 0) {
  console.error(
    `\n${failed} extension(s) could not be staged. Those source formats will report ` +
      `EXTENSION_UNAVAILABLE rather than silently downloading at query time.`,
  );
  process.exit(1);
}
console.log('\nStaged. Datera will not download extensions at query time.');
