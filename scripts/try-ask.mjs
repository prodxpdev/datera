#!/usr/bin/env node
/**
 * End-to-end check against a real local runtime.
 *
 * Usage: node scripts/try-ask.mjs <file> "<question>" [model]
 *
 * The suite drives a stub server, which proves the plumbing but not that a real model
 * behaves. This runs the whole pipeline against whatever is actually installed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Datera, detectLocalRuntimes } from '@datera/core';
import {
  ConsoleLogger, NodeFileSystem, NodeHttp, SystemClock, UnavailableSecretStore,
  nodeDuckDBDriver, resolveExtensionDirectory,
} from '@datera/node-runtime';

const [file, question, wanted] = process.argv.slice(2);
if (!file || !question) {
  console.error('usage: node scripts/try-ask.mjs <file> "<question>" [model]');
  process.exit(1);
}

const http = new NodeHttp();
const runtimes = await detectLocalRuntimes({ http });
if (runtimes.length === 0) {
  console.error('No local runtime detected. Start Ollama with: ollama serve');
  process.exit(1);
}

const runtime = runtimes[0];
const model =
  runtime.models.find((m) => m.id === wanted) ??
  runtime.models.find((m) => /coder/.test(m.id)) ??
  runtime.models[0];

console.log(`Detected ${runtime.provider} at ${runtime.baseUrl} · ${runtime.models.length} models`);
console.log(`Using: ${model.id}\n`);

const workspacePath = await mkdtemp(join(tmpdir(), 'datera-ask-'));
const datera = await Datera.open({
  workspacePath,
  driver: nodeDuckDBDriver(),
  ports: {
    fs: new NodeFileSystem(), clock: new SystemClock(),
    logger: new ConsoleLogger({ minLevel: 'error' }), secrets: new UnavailableSecretStore(), http,
  },
  extensionDirectory: resolveExtensionDirectory(process.cwd()),
});

try {
  const [source] = await datera.addSource({ type: 'file', path: resolve(file) });
  await datera.setChatModel(model);

  console.log(`Source: ${source.name}\nQuestion: ${question}\n`);
  const answer = await datera.ask('ungrouped', question);

  if (!answer.answerable) {
    console.log(`DECLINED — ${answer.flag}\n`);
  } else {
    console.log('SQL:');
    console.log(`  ${answer.sql.replace(/\n/g, '\n  ')}\n`);
    console.log('Rows:');
    console.log(`  ${answer.columns.map((c) => c.name).join(' | ')}`);
    for (const row of answer.rows.slice(0, 8)) console.log(`  ${row.join(' | ')}`);
    if (answer.flag) console.log(`\n  note: ${answer.flag}`);
    console.log(`\nCited: ${answer.citations.sources.join(', ')} · ${answer.citations.rowCount} rows`);
  }

  console.log('\nTrace:');
  for (const s of answer.trace.stages) {
    console.log(`  ${s.label.padEnd(26)} ${String(Math.round(s.durationMs)).padStart(6)}ms${s.modelName ? `  ${s.modelName}` : ''}`);
  }
  console.log(`  ${'TOTAL'.padEnd(26)} ${String(Math.round(answer.trace.totalMs)).padStart(6)}ms · ${answer.trace.inputTokens} in / ${answer.trace.outputTokens} out · $${answer.trace.costUsd.toFixed(4)}`);
} finally {
  await datera.close();
  await rm(workspacePath, { recursive: true, force: true });
}
