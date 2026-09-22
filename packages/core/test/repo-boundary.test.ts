import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repoRoot } from '@datera/testkit';

/**
 * §2, §13 — no server-proprietary code, secrets, or licence logic in the public repo.
 *
 * The two-repo split only means anything if it is checked. This is the same kind of guard
 * as the core purity test: a rule that is locally convenient to break, so it is enforced
 * mechanically rather than remembered.
 */

/** Things that would indicate the private repo's concerns have leaked in here. */
const FORBIDDEN_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bDATERA_LICENSE_KEY\b/, why: 'licence enforcement belongs to datera-server' },
  { pattern: /\bverifyLicen[cs]e\b/i, why: 'licence enforcement belongs to datera-server' },
  { pattern: /\bissueToken\b/, why: 'token issuance belongs to datera-server' },
  { pattern: /\btenantId\b/, why: 'multi-tenant isolation belongs to datera-server' },
  { pattern: /\bassertScopeForToken\b/, why: 'per-token scoping belongs to datera-server' },
  // Credential shapes that should never be committed at all.
  { pattern: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}/, why: 'that looks like a real Anthropic key' },
  { pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, why: 'a private key is committed' },
];

const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', '.git', 'vendor', 'generated', 'release', '.vite', 'docs',
]);

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs|js|json|yml|yaml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('§2/§13 the public repo stays public', () => {
  it('contains no server-proprietary concerns', async () => {
    const root = repoRoot();
    const files = await sourceFiles(root);
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      // This test names the patterns it looks for, so exclude itself.
      if (file.endsWith('repo-boundary.test.ts')) continue;

      const contents = await readFile(file, 'utf8');
      for (const { pattern, why } of FORBIDDEN_PATTERNS) {
        if (pattern.test(contents)) {
          violations.push(`${file.replace(root, '')}: ${String(pattern)} — ${why}`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('declares no dependency on the private server package', async () => {
    const root = repoRoot();
    for (const manifestPath of [
      'package.json',
      'packages/core/package.json',
      'packages/cli/package.json',
      'apps/desktop/package.json',
    ]) {
      const manifest = JSON.parse(await readFile(resolve(root, manifestPath), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...manifest.dependencies, ...manifest.devDependencies };
      expect(Object.keys(all).some((d) => d.includes('datera-server'))).toBe(false);
    }
  });

  describe('negative control — the guard must be able to fail', () => {
    it('detects a planted violation', () => {
      const planted = 'const key = process.env.DATERA_LICENSE_KEY; assertScopeForToken(t);';
      const hits = FORBIDDEN_PATTERNS.filter((p) => p.pattern.test(planted));
      expect(hits.length).toBeGreaterThanOrEqual(2);
    });
  });
});
