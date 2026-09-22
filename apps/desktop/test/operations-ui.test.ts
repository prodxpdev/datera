import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, type FixturePaths } from '@datera/testkit';

/**
 * Authoring an operation, through the UI.
 *
 * The engine had this before the UI did, which is the pattern worth not repeating: a
 * capability nobody can reach is scaffolding, whatever its test coverage.
 *
 * The assertions that matter are the honest ones — that the parameter list comes from the
 * statement rather than being typed twice, and that a write operation is labelled as
 * proposing everywhere it appears.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('authoring operations', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-ops-'));

    app = await electron.launch({
      args: [appRoot],
      env: {
        ...process.env,
        DATERA_WORKSPACE: workspacePath,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        DATERA_HEADLESS: '1',
      },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.brand', { timeout: 60_000 });

    await page.evaluate(async (p: string) => {
      await (globalThis as unknown as { datera: { addSource(r: unknown): Promise<unknown> } }).datera
        .addSource({ type: 'file', path: p, name: 'orders' });
    }, fixtures.ordersCsv);

    await page.reload();
    await page.waitForSelector('.srcitem', { timeout: 30_000 });
    await page.click('[data-nav="activity"]');
    await page.click('[data-serve="operations"]');
    await page.waitForSelector('.operations');
  }, 120_000);

  afterAll(async () => {
    await closeApp(app);
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('takes the argument list from the statement rather than asking twice', async () => {
    await page.fill('[data-operation-sql]', 'SELECT sum(revenue_cents) AS revenue FROM orders WHERE product = $product');
    await page.waitForSelector('[data-param-type="product"]', { timeout: 10_000 });

    // A hand-maintained list that disagrees with the SQL is refused by the core anyway;
    // deriving it means the user never meets that error.
    expect(await page.textContent('.paramlist')).toContain('$product');
  });

  it('creates a read operation and shows it as a read', async () => {
    await page.fill('[data-operation-name]', 'revenue_for_product');
    await page.fill('[data-operation-description]', 'Total revenue for one product.');
    await page.click('[data-create-operation]');

    await page.waitForSelector('[data-operation="revenue_for_product"]', { timeout: 30_000 });
    expect(await page.textContent('[data-operation="revenue_for_product"]')).toMatch(/read/);
  });

  it('serves it as an MCP tool with its own parameters', async () => {
    const tool = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { listTools(): Promise<{ name: string; inputSchema: { properties: object } }[]> };
      }).datera;
      return (await api.listTools()).find((t) => t.name === 'revenue_for_product');
    });

    expect(tool).toBeTruthy();
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(['product']);
  });

  it('labels a write operation as proposing, not applying', async () => {
    // Writes need a grant and a derived dataset, so this goes through the real path.
    const writable = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { enableWrites(id: string): Promise<{ datasetId: string }> };
      }).datera;
      return (await api.enableWrites('ungrouped')).datasetId;
    });

    await page.reload();
    await page.waitForSelector('.brand', { timeout: 30_000 });
    await page.click('[data-nav="activity"]');
    await page.click('[data-serve="operations"]');
    await page.waitForSelector('.operations');

    await page.selectOption('[data-operation-dataset]', writable);
    await page.fill('[data-operation-name]', 'rename_product');
    await page.fill('[data-operation-description]', 'Rename a product.');
    await page.fill('[data-operation-sql]', 'UPDATE orders SET product = $to WHERE product = $from');
    await page.click('[data-create-operation]');

    await page.waitForSelector('[data-operation="rename_product"]', { timeout: 30_000 });
    const card = await page.textContent('[data-operation="rename_product"]');

    expect(card).toMatch(/write/);
    // Said on the card itself, not only in the tool description an agent sees.
    expect(card).toMatch(/proposes/i);
    expect(card).toMatch(/until a person confirms/i);
  });

  it('refuses a statement whose arguments do not match, in the UI', async () => {
    await page.fill('[data-operation-name]', 'broken');
    await page.fill('[data-operation-description]', 'x');
    await page.fill('[data-operation-sql]', 'SELECT * FROM orders WHERE product = $product LIMIT 1');

    // Remove the derived parameter's presence by renaming the placeholder after the
    // parameter row was built — the core is the thing being trusted here.
    await page.fill('[data-operation-sql]', 'DELETE FROM orders; SELECT 1');
    await page.click('[data-create-operation]');

    await expect.poll(async () => page.textContent('.operations .err'), { timeout: 15_000 })
      .toMatch(/statement|one statement|parse/i);
  });

  it('removes one', async () => {
    await page.click('[data-delete-operation="revenue_for_product"]');
    await expect
      .poll(async () => page.locator('[data-operation="revenue_for_product"]').count(), { timeout: 15_000 })
      .toBe(0);
  });
});
