#!/usr/bin/env node
/**
 * Poke the core directly, without the desktop app.
 *
 * Usage:  node scripts/try-core.mjs <file> [<file> ...]
 *         node scripts/try-core.mjs fixtures/generated/orders.csv
 *
 * Uses a throwaway workspace in your temp directory, so it never touches the app's real
 * one — and, like everything else, it never touches your source files.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Datera } from '@datera/core';
import {
  ConsoleLogger, NodeFileSystem, SystemClock, UnavailableSecretStore,
  nodeDuckDBDriver, resolveExtensionDirectory,
} from '@datera/node-runtime';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/try-core.mjs <file> [<file> ...]');
  process.exit(1);
}

const workspacePath = await mkdtemp(join(tmpdir(), 'datera-try-'));
const datera = await Datera.open({
  workspacePath,
  driver: nodeDuckDBDriver(),
  ports: {
    fs: new NodeFileSystem(),
    clock: new SystemClock(),
    logger: new ConsoleLogger({ minLevel: 'warn' }),
    secrets: new UnavailableSecretStore(),
  },
  extensionDirectory: resolveExtensionDirectory(process.cwd()),
});

const info = datera.engineInfo();
console.log(`DuckDB ${info.duckdbVersion} · ${info.driver}`);
console.log(`extensions: ${info.extensions.filter((e) => e.loaded).map((e) => e.name).join(', ')}\n`);

try {
  for (const file of files) {
    const path = resolve(file);
    const isDb = /\.(sqlite|sqlite3|db)$/i.test(path);
    const sources = await datera.addSource(isDb ? { type: 'sqlite', path } : { type: 'file', path });

    for (const source of sources) {
      const schema = await datera.getSchema(source.id);
      console.log(`── ${source.name}  (${source.kind}, ${schema.rowCount.toLocaleString()} rows)`);
      console.log(`   read via: ${source.detection.method}`);

      for (const w of source.detection.warnings ?? []) console.log(`   ⚠ ${w}`);

      for (const c of schema.columns) {
        const nulls = c.nullCount > 0 ? `  ${c.nullCount} null` : '';
        const flag = c.inference?.verdict === 'ambiguous' ? `\n       ⚠ ${c.inference.evidence}` : '';
        console.log(`   ${c.name.padEnd(22)} ${c.type.padEnd(12)}${nulls}${flag}`);
      }

      const preview = await datera.preview(source.id, { limit: 3 });
      console.log(`   first rows: ${preview.rows.map((r) => r.join(' | ')).join('\n               ')}\n`);
    }
  }

  // Prove the read-only guard from the outside.
  console.log('── read-only guard');
  const first = (await datera.listSources())[0];
  if (first !== undefined) {
    for (const sql of [`DELETE FROM "${first.name}"`, `COPY "${first.name}" TO '/tmp/leak.csv'`, `SELECT 1; DROP TABLE "${first.name}";`]) {
      try {
        await datera.query('ungrouped', sql);
        console.log(`   ✗ ALLOWED (this is a bug): ${sql}`);
      } catch (e) {
        console.log(`   ✓ refused [${e.code}]: ${sql}`);
      }
    }
    const ok = await datera.query('ungrouped', `SELECT count(*) AS n FROM "${first.name}"`);
    console.log(`   ✓ allowed: SELECT count(*) → ${ok.rows[0][0]}  (${ok.durationMs.toFixed(1)}ms)`);
  }
} finally {
  await datera.close();
  await rm(workspacePath, { recursive: true, force: true });
}
