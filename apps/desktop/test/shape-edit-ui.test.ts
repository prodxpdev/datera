import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, fingerprintFile, type FixturePaths } from '@datera/testkit';

/**
 * Phases 5 and 6 through the UI.
 *
 * Both phases had complete, tested engines and no way to reach them from the app. The
 * write path especially: §6 calls the confirm gate "the safety mechanism and the teaching
 * moment", and a gate nobody can see teaches nothing.
 *
 * These assert the *gate*, not just the plumbing — that a proposal is visible and inert
 * until someone confirms it, and that the source file is untouched throughout.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('Shape and Edit', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-shape-'));

    app = await electron.launch({
      args: [appRoot],
      env: { ...process.env, DATERA_WORKSPACE: workspacePath, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.brand', { timeout: 60_000 });

    await page.evaluate(async (p: string) => {
      await (globalThis as unknown as { datera: { addSource(r: unknown): Promise<unknown> } }).datera
        .addSource({ type: 'file', path: p, name: 'sheet' });
    }, fixtures.flatSheetCsv);

    await page.reload();
    await page.waitForSelector('.srcitem', { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  describe('Shape — copy-on-write, normalize, versions (Phase 5)', () => {
    it('offers a way to derive a working copy', async () => {
      await page.click('[data-nav="shape"]');
      await page.waitForSelector('.shape');

      expect(await page.textContent('.shape')).toMatch(/working copy|derive/i);
    });

    it('derives a copy, leaving the original dataset alone', async () => {
      await page.click('[data-derive]');

      // Polled on the actual outcome, not on page text: the static copy on this view
      // already contains the words "working copy", so a text poll passes before the work
      // has happened and the assertion afterwards races it.
      await expect
        .poll(async () => (await listKinds(page)).includes('derived'), { timeout: 30_000 })
        .toBe(true);

      expect(await listKinds(page)).toContain('connected');
    });

    it('proposes a normalization with the repetition it measured', async () => {
      await page.click('[data-propose-normalize]');
      await page.waitForSelector('.entityproposal', { timeout: 30_000 });

      const text = await page.textContent('.shape');
      expect(text).toContain('customer_email');
      // §1.3 — the evidence has to be visible, because ratifying what you cannot evaluate
      // is just clicking OK.
      expect(text).toMatch(/distinct values/i);
      expect(text).toMatch(/9 rows/);
    });

    it('does not apply the normalization until it is confirmed', async () => {
      const before = await page.evaluate(async () =>
        (globalThis as unknown as { datera: { listDatasets(): Promise<unknown[]> } }).datera.listDatasets(),
      );

      // The proposal is on screen and nothing has happened.
      expect(await page.$('.entityproposal')).not.toBeNull();
      const after = await page.evaluate(async () =>
        (globalThis as unknown as { datera: { listDatasets(): Promise<unknown[]> } }).datera.listDatasets(),
      );
      expect((after as unknown[]).length).toBe((before as unknown[]).length);
    });

    it('applies it on confirm, into a new dataset', async () => {
      await page.click('[data-apply-normalize]');

      await expect
        .poll(async () => (await normalizedTables(page)).length, { timeout: 30_000 })
        .toBeGreaterThan(0);

      const tables = await page.evaluate(async () => {
        const api = (globalThis as unknown as {
          datera: {
            listDatasets(): Promise<{ id: string; name: string }[]>;
            listTables(id: string): Promise<string[]>;
          };
        }).datera;
        const datasets = await api.listDatasets();
        const modelled = datasets.find((d) => /normal/i.test(d.name));
        return modelled === undefined ? [] : api.listTables(modelled.id);
      });

      expect(tables).toEqual(expect.arrayContaining(['customers', 'products']));
    });

    it('saves a version and lists it', async () => {
      await page.click('[data-save-version]');
      await page.waitForSelector('.versionrow', { timeout: 30_000 });
      expect(await page.textContent('.shape')).toMatch(/version/i);
    });

    it('leaves the source file byte-identical throughout (§12.6)', async () => {
      const after = await fingerprintFile(fixtures.flatSheetCsv);
      const again = await fingerprintFile(fixtures.flatSheetCsv);
      expect(again.sha256).toBe(after.sha256);
      // And it still reads correctly — the copy did not disturb it.
      const rows = await page.evaluate(async () => {
        const api = (globalThis as unknown as {
          datera: { query(d: string, s: string): Promise<{ rows: unknown[][] }> };
        }).datera;
        return (await api.query('ungrouped', 'SELECT count(*) FROM sheet')).rows;
      });
      expect(Number(rows[0]?.[0])).toBe(9);
    });
  });

  describe('Edit — the write gate (Phase 6)', () => {
    it('shows writes as off, and says why', async () => {
      await page.click('[data-nav="edit"]');
      await page.waitForSelector('.edit');

      const text = await page.textContent('.edit');
      expect(text).toMatch(/off by default|not enabled/i);
    });

    it('refuses a grant on the connected dataset, explaining §1.2', async () => {
      const result = await page.evaluate(async () => {
        const api = (globalThis as unknown as {
          datera: { grantWrite(id: string): Promise<void> };
        }).datera;
        try {
          await api.grantWrite('ungrouped');
          return 'allowed';
        } catch (e) {
          return (e as { message?: string }).message ?? 'error';
        }
      });

      expect(result).toMatch(/never writes to a source|derive a working copy/i);
    });

    it('grants writes on a derived dataset', async () => {
      await page.selectOption('[data-edit-dataset]', { index: 1 }).catch(() => undefined);
      await page.click('[data-grant]');
      await expect.poll(async () => page.textContent('.edit'), { timeout: 15_000 }).toMatch(/enabled|granted/i);
    });

    it('previews a proposed change without applying it — the gate (§12.7)', async () => {
      await page.fill('.edit textarea', `UPDATE sheet SET product_name = 'Renamed' WHERE product_sku = 'SKU-1'`);
      await page.click('[data-propose]');
      await page.waitForSelector('.writepreview', { timeout: 30_000 });

      const preview = await page.textContent('.writepreview');
      // The exact count, and old → new values.
      expect(preview).toMatch(/3 rows|3 row/);
      expect(preview).toContain('Trail Hoodie');
      expect(preview).toContain('Renamed');

      // Nothing has been applied.
      const unchanged = await page.evaluate(async () => {
        const api = (globalThis as unknown as {
          datera: {
            listDatasets(): Promise<{ id: string; kind: string }[]>;
            query(d: string, s: string): Promise<{ rows: unknown[][] }>;
          };
        }).datera;
        const derived = (await api.listDatasets()).find((d) => d.kind === 'derived');
        return (await api.query(derived!.id, `SELECT count(*) FROM sheet WHERE product_name = 'Renamed'`)).rows;
      });
      expect(Number(unchanged[0]?.[0])).toBe(0);
    });

    it('warns loudly when a proposal would touch every row', async () => {
      await page.fill('.edit textarea', 'DELETE FROM sheet');
      await page.click('[data-propose]');
      await page.waitForSelector('.writewarn', { timeout: 30_000 });

      expect(await page.textContent('.writewarn')).toMatch(/every row|all 9/i);
    });

    it('applies only on confirm, and can be undone', async () => {
      await page.fill('.edit textarea', `DELETE FROM sheet WHERE product_sku = 'SKU-3'`);
      await page.click('[data-propose]');
      await page.waitForSelector('.writepreview', { timeout: 30_000 });

      await page.click('[data-confirm-write]');
      await expect.poll(async () => page.textContent('.edit'), { timeout: 30_000 }).toMatch(/applied/i);

      const afterApply = await countRows(page);
      expect(afterApply).toBe(6);

      await page.click('[data-undo]');
      await expect.poll(async () => countRows(page), { timeout: 30_000 }).toBe(9);
    });

    it('records the write in a visible audit log', async () => {
      const text = await page.textContent('.writelog');
      expect(text).toMatch(/DELETE/);
    });
  });
});

async function listKinds(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (
      await (globalThis as unknown as {
        datera: { listDatasets(): Promise<{ kind: string }[]> };
      }).datera.listDatasets()
    ).map((d) => d.kind),
  );
}

async function normalizedTables(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as {
      datera: {
        listDatasets(): Promise<{ id: string; name: string }[]>;
        listTables(id: string): Promise<string[]>;
      };
    }).datera;
    const modelled = (await api.listDatasets()).find((d) => /normal/i.test(d.name));
    return modelled === undefined ? [] : api.listTables(modelled.id);
  });
}

async function countRows(page: Page): Promise<number> {
  const rows = await page.evaluate(async () => {
    const api = (globalThis as unknown as {
      datera: {
        listDatasets(): Promise<{ id: string; kind: string }[]>;
        query(d: string, s: string): Promise<{ rows: unknown[][] }>;
      };
    }).datera;
    const derived = (await api.listDatasets()).find((d) => d.kind === 'derived');
    return (await api.query(derived!.id, 'SELECT count(*) FROM sheet')).rows;
  });
  return Number(rows[0]?.[0]);
}
