import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@datera/testkit';

/**
 * The marketing site does not claim more than the product does.
 *
 * Datera's entire pitch is that it does not hide things, which makes an overstated claim on
 * its own site a worse failure than a missing feature. And marketing copy drifts in exactly
 * the way code does not: nothing breaks when a format is removed or a product slips, so
 * nobody notices.
 *
 * Narrow on purpose. This asserts the handful of claims that are mechanically checkable
 * against this repo — not tone, not positioning, not anything needing judgement.
 */
const site = (): string => readFileSync(join(repoRoot(), 'site', 'index.html'), 'utf8');

describe('what the site claims', () => {
  it('names only source formats that are actually supported', () => {
    // Every format the pricing card lists must be one the core can really connect.
    const claimed = ['CSV', 'TSV', 'Excel', 'JSON', 'Parquet', 'SQLite', 'Postgres', 'MySQL'];
    const sources = join(repoRoot(), 'packages', 'core', 'src', 'sources');
    const supported = ['files.ts', 'attachments.ts', 'types.ts']
      .map((f) => readFileSync(join(sources, f), 'utf8'))
      .join('\n')
      .toLowerCase();

    const html = site();
    for (const format of claimed) {
      if (!html.includes(format)) continue;
      // Excel is the user-facing name for the xlsx reader.
      const token = format === 'Excel' ? 'xlsx' : format.toLowerCase();
      expect(supported, `the site claims ${format}`).toContain(token);
    }
  });

  it('does not offer Datera Server for sale while it is unbuilt', () => {
    // PLAN.md Epic 8: "PRIVATE REPO, NOT BUILT HERE". A priced button for it would be
    // selling something nobody can buy, on the one site that cannot afford to do that.
    const plan = readFileSync(join(repoRoot(), 'PLAN.md'), 'utf8');
    const unbuilt = plan.includes('Epic 8 — Datera Server + deploy — **PRIVATE REPO, NOT BUILT HERE**');
    if (!unbuilt) return;

    const html = site();
    expect(html).not.toMatch(/Get Datera Server/i);
    expect(html).toMatch(/not for sale yet|not yet available|in development/i);
  });

  it('states the licence the repo actually carries', () => {
    // D-09: the copy once said "MIT-spirited", which an Apache-2.0 project is not.
    const licence = readFileSync(join(repoRoot(), 'LICENSE'), 'utf8');
    expect(licence).toContain('Apache License');

    const html = site();
    expect(html).toContain('Apache-2.0');
    expect(html).not.toMatch(/\bMIT\b/);
  });

  it('does not promise a Mac build that is no longer produced', () => {
    // The Intel installer was dropped when GitHub stopped allocating macos-13 runners.
    // An unqualified "Mac" sends those users a build that cannot launch.
    const workflow = readFileSync(join(repoRoot(), '.github', 'workflows', 'package.yml'), 'utf8');
    if (workflow.includes('macOS (Intel)')) return;

    expect(site()).toMatch(/Apple Silicon/);
  });
});
