import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repoRoot } from '@datera/testkit';

/**
 * P1-03 — the core purity guard. Invariant §1.7 as a test rather than a convention.
 *
 * "The core is a standalone library with no desktop- or server-specific dependencies" is
 * the kind of rule that is true on day one and quietly false by month three, because
 * violating it is always locally convenient. So it is checked mechanically.
 *
 * Note the negative-control test at the bottom: a guard that has never been shown to fail
 * is not a guard, it is a decoration.
 */

/** Runtime dependencies only. Test-time tooling is not shipped and does not constrain the core. */
const FORBIDDEN_RUNTIME_DEPS = [
  'electron',
  'electron-builder',
  '@duckdb/node-api',
  '@duckdb/node-bindings',
  'express',
  'fastify',
  'koa',
  'http-server',
  'ws',
  'keytar',
  '@datera/testkit',
  '@datera/node-runtime',
];

/**
 * Node builtins the core must not reach for directly.
 *
 * `node:fs` is the important one: the core takes a `FileSystemPort` precisely so a
 * browser/wasm host (spec §2a, the iPad path) can satisfy it. A direct `node:fs` import
 * would silently make the core Node-only again.
 *
 * `node:path` is permitted nowhere either — `util/paths.ts` exists instead — so that the
 * core carries no assumption about the host's path semantics.
 */
const FORBIDDEN_BUILTINS = [
  'node:fs', 'node:fs/promises', 'fs', 'fs/promises',
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns',
  'http', 'https', 'net', 'tls', 'dns',
  'node:child_process', 'child_process',
  'node:os', 'os',
  'node:path', 'path',
  'node:worker_threads', 'worker_threads',
];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])require\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_PATTERN.lastIndex = 0;
  while ((match = IMPORT_PATTERN.exec(source)) !== null) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) specifiers.push(spec);
  }
  return specifiers;
}

describe('P1-03 core purity guard (invariant §1.7)', () => {
  const coreSrc = resolve(repoRoot(), 'packages', 'core', 'src');

  it('declares no forbidden runtime dependency', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repoRoot(), 'packages', 'core', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    const declared = Object.keys(manifest.dependencies ?? {});
    const violations = declared.filter((d) => FORBIDDEN_RUNTIME_DEPS.includes(d));
    expect(violations, `@datera/core must not depend on: ${violations.join(', ')}`).toEqual([]);
  });

  it('imports no host-specific module anywhere in its source', async () => {
    const files = await sourceFiles(coreSrc);
    expect(files.length).toBeGreaterThan(10);

    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of importsOf(source)) {
        if (FORBIDDEN_BUILTINS.includes(spec) || FORBIDDEN_RUNTIME_DEPS.includes(spec)) {
          violations.push(`${file.replace(repoRoot(), '')} imports "${spec}"`);
        }
        if (spec.includes('apps/') || spec.includes('node-runtime')) {
          violations.push(`${file.replace(repoRoot(), '')} reaches into a host: "${spec}"`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('exposes exactly one public entry point', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repoRoot(), 'packages', 'core', 'package.json'), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    // Hosts call the façade. Subpath entries would let a host reach into internals and
    // couple itself to the core's file layout.
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.']);
  });

  it('the built core loads without any host package present', async () => {
    // The strongest form of the check: actually import the published artifact. If the core
    // had a hidden dependency on the Node runtime package, this would throw.
    const dist = resolve(repoRoot(), 'packages', 'core', 'dist', 'index.js');
    expect((await stat(dist)).isFile()).toBe(true);

    const mod = (await import(dist)) as Record<string, unknown>;
    expect(typeof mod['Datera']).toBe('function');
    expect(typeof mod['assertReadOnlySql']).toBe('function');
  });

  describe('negative control — the guard must be able to fail', () => {
    it('detects a planted forbidden import', () => {
      // The guard is only worth having if it fires. This proves the detection logic works
      // on source that genuinely violates the rule, without committing such a file.
      const planted = [
        `import { readFile } from 'node:fs/promises';`,
        `import { app } from 'electron';`,
        `const x = require('express');`,
        `await import('@duckdb/node-api');`,
      ].join('\n');

      const found = importsOf(planted);
      expect(found).toContain('node:fs/promises');
      expect(found).toContain('electron');
      expect(found).toContain('express');
      expect(found).toContain('@duckdb/node-api');

      const violations = found.filter(
        (s) => FORBIDDEN_BUILTINS.includes(s) || FORBIDDEN_RUNTIME_DEPS.includes(s),
      );
      expect(violations).toHaveLength(4);
    });

    it('does not flag legitimate imports', () => {
      const legitimate = [
        `import { DateraError } from '../errors.js';`,
        `import type { Engine } from './engine/engine.js';`,
        `import { quoteIdent } from '../engine/sql.js';`,
      ].join('\n');

      const violations = importsOf(legitimate).filter(
        (s) => FORBIDDEN_BUILTINS.includes(s) || FORBIDDEN_RUNTIME_DEPS.includes(s),
      );
      expect(violations).toEqual([]);
    });
  });
});
