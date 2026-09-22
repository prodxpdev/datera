import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
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
      env: { ...process.env, DATERA_WORKSPACE: workspacePath, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DATERA_HEADLESS: '1' },
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
    await closeApp(app);
    await rm(workspacePath, { recursive: true, force: true });
  });

  describe('Shape — copy-on-write, normalize, versions (Phase 5)', () => {
    it('offers a way to derive a working copy', async () => {
      await page.click('[data-nav="data"]');
      await page.click('[data-data="shape"]');
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

  /**
   * The write path, after it stopped being its own nav item.
   *
   * Enabling writes is a property of a dataset, so it lives in Data beside the dataset —
   * next to the copy-on-write step that makes it possible at all. Making a change is
   * writing a statement, so it happens in Query, in the same editor as every read. Two
   * surfaces for one editor was the thing to fix; the gate itself is untouched, and these
   * tests still assert it holds.
   */
  describe('The write gate, in its new homes (Phase 6)', () => {
    it('shows writes as off, and says why, beside the dataset in Data', async () => {
      await page.click('[data-nav="data"]');
      await page.click('[data-data="access"]');
      await page.waitForSelector('.writeaccess');

      const text = await page.textContent('.writeaccess');
      expect(text).toMatch(/off by default|not enabled|read-only/i);
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

    it('grants writes on a derived dataset, from Data', async () => {
      const derived = await workingCopyId(page);
      await page.click(`[data-grant="${derived}"]`);
      await expect
        .poll(async () => page.textContent('.writeaccess'), { timeout: 15_000 })
        .toMatch(/enabled|granted/i);
    });

    it('previews a proposed change without applying it — the gate (§12.7)', async () => {
      // Same editor as every read. The dataset switcher in the chrome decides what it
      // runs against, which is the point of hoisting it there.
      await switchToDerived(page);
      await openQuery(page);

      await page.fill('[data-sql]', `UPDATE sheet SET product_name = 'Renamed' WHERE product_sku = 'SKU-1'`);
      await page.click('[data-runsql]');
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
      await page.fill('[data-sql]', 'DELETE FROM sheet');
      await page.click('[data-runsql]');
      await page.waitForSelector('.writewarn', { timeout: 30_000 });

      expect(await page.textContent('.writewarn')).toMatch(/every row|all 9/i);
    });

    it('applies only on confirm', async () => {
      await page.fill('[data-sql]', `DELETE FROM sheet WHERE product_sku = 'SKU-3'`);
      await page.click('[data-runsql]');
      await page.waitForSelector('.writepreview', { timeout: 30_000 });

      await page.click('[data-confirm-write]');
      await expect.poll(async () => countRows(page), { timeout: 30_000 }).toBe(6);
    });

    it('records the write in an audit log in Data, and undoes it there', async () => {
      // The history of what changed a dataset belongs with the dataset, not in a third
      // place — that is the same reason the grant moved.
      await page.click('[data-nav="data"]');
      await page.click('[data-data="access"]');
      await page.waitForSelector('.writelog');
      // Polled: the log renders immediately and fills in from an async read, so a direct
      // assertion here races the refresh rather than testing anything.
      await expect
        .poll(async () => page.textContent('.writelog'), { timeout: 30_000 })
        .toMatch(/DELETE/);

      await page.click('[data-undo]');
      await expect.poll(async () => countRows(page), { timeout: 30_000 }).toBe(9);
    });

    it('explains the refusal, and offers the grant, when writes are off', async () => {
      await page.click('[data-nav="data"]');
      await page.click('[data-data="access"]');
      await page.click(`[data-revoke="${await workingCopyId(page)}"]`);

      await openQuery(page);
      await page.fill('[data-sql]', `DELETE FROM sheet WHERE product_sku = 'SKU-2'`);
      await page.click('[data-runsql]');
      await page.waitForSelector('[data-refusal]', { timeout: 30_000 });

      // The refusal names the consequence and offers the fix where the refusal happened,
      // rather than sending the user to look for a setting.
      expect(await page.textContent('[data-refusal]')).toMatch(/writes are not enabled|enable writes/i);
      expect(await page.locator('[data-grant-here]').count()).toBe(1);
      expect(await countRows(page)).toBe(9);
    });
  });
});

/**
 * Open Query and wait for it to finish loading before typing into it.
 *
 * Mounting the view reads the schema and writes a starter query into the editor. Filling
 * the editor before that lands means the starter SQL overwrites what was typed, and Run
 * then executes a harmless SELECT — which fails the test in a way that looks like the
 * feature is broken rather than the test being early.
 */
async function openQuery(page: Page): Promise<void> {
  await page.click('[data-nav="query"]');
  await page.waitForSelector('[data-sql]');
  await expect
    .poll(async () => page.inputValue('[data-sql]'), { timeout: 30_000 })
    .not.toBe('');
}

/**
 * The working copy specifically.
 *
 * `find(d => d.kind === 'derived')` is ambiguous here: applying a normalization also
 * produces a derived dataset, so the loose match returned whichever the catalog listed
 * first and the grant and the revoke could land on different datasets.
 */
async function workingCopyId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as {
      datera: { listDatasets(): Promise<{ id: string; name: string; kind: string }[]> };
    }).datera;
    const copy = (await api.listDatasets()).find((d) => d.kind === 'derived' && /copy/i.test(d.name));
    if (copy === undefined) throw new Error('no working copy in this workspace');
    return copy.id;
  });
}

/** Point the chrome's dataset switcher at the working copy. */
async function switchToDerived(page: Page): Promise<void> {
  await page.selectOption('[data-dataset-switch]', await workingCopyId(page));
}

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
  const id = await workingCopyId(page);
  const rows = await page.evaluate(async (datasetId: string) => {
    const api = (globalThis as unknown as {
      datera: { query(d: string, s: string): Promise<{ rows: unknown[][] }> };
    }).datera;
    return (await api.query(datasetId, 'SELECT count(*) FROM sheet')).rows;
  }, id);
  return Number(rows[0]?.[0]);
}
