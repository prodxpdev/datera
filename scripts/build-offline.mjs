#!/usr/bin/env node
/**
 * Build the offline installer — the app with a model inside it.
 *
 * The default build fetches weights on first run, which is the right default: a 2.1 GB
 * file cannot be a GitHub release asset at all, it would be paid for by every user
 * including everyone who brings their own key, and it forces one model size on every
 * machine.
 *
 * This variant exists for the case that default genuinely fails: a classroom with no
 * per-student internet, which §11 names as a reason this product exists. One artifact,
 * built deliberately, not the thing people download by accident.
 *
 * Usage:
 *   node scripts/build-offline.mjs [model-id]
 *
 * Defaults to the 1.5B rather than the 3B: an installer is downloaded once by someone
 * with bandwidth and then copied around, and the machines it lands on in this scenario are
 * usually the modest ones.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_MODELS } from '@datera/core';
import { NodeLocalLlm } from '@datera/node-runtime';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const staging = join(desktop, 'models');

const modelId = process.argv[2] ?? BUNDLED_MODELS[0].id;
const spec = BUNDLED_MODELS.find((m) => m.id === modelId);
if (spec === undefined) {
  console.error(`Unknown model "${modelId}". One of: ${BUNDLED_MODELS.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

console.log(`Offline build with ${spec.label} (${(spec.sizeBytes / 1024 ** 3).toFixed(1)} GB).`);

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

// Downloaded through the same verified path the app uses, so an offline installer cannot
// end up carrying weights that would have been rejected at runtime.
const llm = new NodeLocalLlm({ directory: staging });
let lastLogged = 0;
await llm.ensure(spec.id, ({ receivedBytes, totalBytes }) => {
  if (receivedBytes - lastLogged < 200_000_000) return;
  lastLogged = receivedBytes;
  console.log(`  ${(receivedBytes / 1024 ** 3).toFixed(2)} / ${(totalBytes / 1024 ** 3).toFixed(2)} GB`);
});
await llm.dispose();

console.log('Verified. Packaging…');

execFileSync(
  'npx',
  [
    'electron-builder',
    '--mac', 'dmg',
    '--arm64',
    // extraResources rather than files: it lands in Contents/Resources/models, which is
    // exactly where the app looks for seeded weights.
    '--config.extraResources=models',
    '--config.productName=Datera',
    `--config.artifactName=Datera-with-model-\${arch}.\${ext}`,
  ],
  { cwd: desktop, stdio: 'inherit' },
);

console.log('\nDone. The normal build is unchanged and still fetches on first run.');
