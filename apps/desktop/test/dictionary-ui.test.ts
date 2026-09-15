import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, type FixturePaths } from '@datera/testkit';

/**
 * The dictionary's drafting loop.
 *
 * §1.3 says Datera proposes and a human confirms. It does not say the human must confirm
 * one row at a time, nor that confirming one row should throw away the other eleven
 * proposals — which is what happened: the reload after a confirm cleared the draft, so
 * ratifying twelve columns meant twelve drafts. Reviewing a batch and accepting it is
 * still ratification; re-deriving the batch after each click is just a bug.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('Dictionary drafting', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-dict-'));

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
    await page.click('[data-nav="meaning"]');
    await page.waitForSelector('.dicttbl', { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('drafts meanings without saving any of them', async () => {
    await page.click('[data-autodraft]');
    await expect.poll(async () => page.textContent('.dicttbl'), { timeout: 60_000 })
      .not.toMatch(/no meaning yet/);

    // Drafted, and every row still says so.
    expect(await page.$$('.mst.sg')).not.toHaveLength(0);
    expect(await confirmedInStore(page)).toBe(0);
  });

  it('keeps the rest of the draft when one row is confirmed', async () => {
    const drafted = await page.$$eval('.dicttbl tbody tr', (rows) => rows.length);

    await page.click('.dicttbl tbody tr:first-child [data-confirm-row]');
    await expect.poll(async () => confirmedInStore(page), { timeout: 30_000 }).toBe(1);

    // The bug: this used to drop back to "no meaning yet" for every other row, so the
    // only way forward was to draft all over again.
    const stillProposed = await page.$$eval('.dicttbl tbody tr', (rows) =>
      rows.filter((r) => !/no meaning yet/.test(r.textContent ?? '')).length,
    );
    expect(stillProposed).toBe(drafted);
  });

  it('confirms every remaining drafted row at once', async () => {
    const rows = await page.$$eval('.dicttbl tbody tr', (r) => r.length);

    await page.click('[data-confirm-all]');
    await expect.poll(async () => confirmedInStore(page), { timeout: 30_000 }).toBe(rows);

    // And the button retires itself — there is nothing left to accept.
    await expect.poll(async () => page.locator('[data-confirm-all]').count(), { timeout: 15_000 }).toBe(0);
  });
});

async function confirmedInStore(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as {
      datera: {
        listSources(): Promise<{ id: string }[]>;
        getDictionary(id: string): Promise<{ columns: { state: string }[] }>;
      };
    }).datera;
    const source = (await api.listSources())[0]!;
    const dictionary = await api.getDictionary(source.id);
    return dictionary.columns.filter((c) => c.state === 'confirmed').length;
  });
}
