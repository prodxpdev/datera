import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * Author from intent, through the UI (§3a).
 *
 * §3a calls this one of two first-class entry paths, and it was the one nobody could
 * reach: the core seam shipped in Phase 1 and the UI never did. A path that exists only
 * in a façade method is not an entry path.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('defining a schema with no data', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-author-'));
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
    await page.click('[data-nav="data"]');
    await page.click('[data-data="author"]');
    await page.waitForSelector('.author');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('is reachable from Data, beside connecting a source', async () => {
    // Not buried in settings: §3a says both entry paths are first-class, and where it
    // sits is most of what communicates that.
    expect(await page.textContent('.author')).toMatch(/no data yet/i);
  });

  it('reads pasted DDL into a proposal without creating anything', async () => {
    await page.fill(
      '[data-author-sql]',
      'CREATE TABLE customers (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL);',
    );
    await page.click('[data-author-read]');
    await page.waitForSelector('[data-schema-proposal]', { timeout: 30_000 });

    const proposal = await page.textContent('[data-schema-proposal]');
    expect(proposal).toContain('customers');
    expect(proposal).toContain('primary');
    expect(proposal).toMatch(/Nothing has been created/i);

    const tables = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { listTables(id: string): Promise<string[]> };
      }).datera;
      return api.listTables('ungrouped');
    });
    expect(tables).not.toContain('customers');
  });

  it('creates the tables when confirmed, and they are immediately queryable', async () => {
    await page.click('[data-author-apply]');
    await expect.poll(async () => page.textContent('.author'), { timeout: 30_000 })
      .toMatch(/Created customers/);

    const rows = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { query(d: string, s: string): Promise<{ rows: unknown[][] }> };
      }).datera;
      return (await api.query('ungrouped', 'SELECT count(*) FROM customers')).rows;
    });
    // Empty, but real: one internal model, two entry paths.
    expect(Number(rows[0]?.[0])).toBe(0);
  });

  it('shows the database’s own error for a bad paste', async () => {
    await page.fill('[data-author-sql]', 'CREATE TABLE (oops');
    await page.click('[data-author-read]');

    await expect.poll(async () => page.textContent('.author .err'), { timeout: 30_000 })
      .toMatch(/syntax|parser/i);
  });

  it('refuses a paste that is not table definition', async () => {
    // The box takes text the user may not have read, quite possibly generated.
    await page.fill('[data-author-sql]', 'DROP TABLE customers');
    await page.click('[data-author-read]');

    await expect.poll(async () => page.textContent('.author .err'), { timeout: 30_000 })
      .toMatch(/CREATE TABLE statements/i);

    const tables = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { listTables(id: string): Promise<string[]> };
      }).datera;
      return api.listTables('ungrouped');
    });
    expect(tables).toContain('customers');
  });
});
