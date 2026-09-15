import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, startStubModelServer, type FixturePaths, type StubModelServer } from '@datera/testkit';

/**
 * Phase 2 through the real shell.
 *
 * The glass box is the product (invariant §1.4), which makes "the drawer shows the SQL and
 * the payload" a correctness requirement rather than a presentation detail — so it is
 * asserted in the UI, not only in the core.
 */

const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('Ask and the transparency drawer', () => {
  let app: ElectronApplication;
  let page: Page;
  let server: StubModelServer;
  let workspacePath: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-ask-ui-'));

    app = await electron.launch({
      args: [appRoot],
      env: { ...process.env, DATERA_WORKSPACE: workspacePath, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.brand', { timeout: 60_000 });

    await page.evaluate(
      async ([path, url]: readonly string[]) => {
        const api = (globalThis as unknown as {
          datera: { addSource(r: unknown): Promise<unknown>; setChatModel(m: unknown): Promise<void> };
        }).datera;
        await api.addSource({ type: 'file', path, name: 'orders' });
        await api.setChatModel({
          tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
          locality: 'local', endpoint: url, label: 'llama3.1:8b',
        });
      },
      [fixtures.ordersCsv, server.url],
    );

    await page.reload();
    await page.waitForSelector('.srcitem', { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await server.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function askInUi(question: string): Promise<void> {
    await page.click('[data-nav="ask"]');
    await page.waitForSelector('.askbar input');
    await page.fill('.askbar input', question);
    await page.click('.askbar button');
    await page.waitForSelector('.card.ans, .flag', { timeout: 30_000 });
  }

  it('answers a question and shows the rows', async () => {
    server.setReply('SELECT product, sum(revenue_cents) AS revenue FROM orders GROUP BY product ORDER BY revenue DESC');
    await askInUi('top products by revenue');

    await expect.poll(async () => page.$$eval('.ansrows tbody tr', (r) => r.length)).toBeGreaterThan(0);
    expect(await page.textContent('.ansrows')).toContain('Trail Hoodie');
  });

  it('shows citations for the answer', async () => {
    const cites = await page.$$eval('.cite', (els) => els.map((e) => e.textContent ?? ''));
    expect(cites.join(' ')).toContain('orders');
    expect(cites.join(' ')).toMatch(/row/i);
  });

  it('opens the glass box and shows the generated SQL', async () => {
    await page.click('[data-how]');
    await page.waitForSelector('.drawer.show');

    const drawer = await page.textContent('.drawer');
    expect(drawer).toContain('SELECT product');
    expect(drawer).toMatch(/Generated SQL/i);
  });

  it('names the exact model in the drawer, per spec §9', async () => {
    const drawer = await page.textContent('.drawer');
    expect(drawer).toContain('Ollama · llama3.1:8b');
    expect(drawer).toContain('local');
    expect(drawer).not.toContain('the local model');
  });

  it('shows what was sent to the model, and that it contained no data rows', async () => {
    const payload = await page.textContent('.stage-model .payload');
    expect(payload).toBeTruthy();
    expect(payload).toContain('orders');
    expect(payload).toContain('revenue_cents');
    // The proof the user is being shown: schema went, values did not.
    expect(payload).not.toContain('Trail Hoodie');
    expect(payload).not.toContain('A-1042');
  });

  it('shows the cost, and zero for a local model', async () => {
    const drawer = await page.textContent('.drawer');
    expect(drawer).toMatch(/\$0|no cost|runs on this machine/i);
  });

  it('shows every stage of the pipeline in order', async () => {
    const stages = await page.$$eval('.stage .sl', (els) => els.map((e) => e.textContent ?? ''));
    expect(stages.length).toBeGreaterThanOrEqual(6);
    expect(stages.join(' ')).toMatch(/Routing/i);
    expect(stages.join(' ')).toMatch(/Schema/i);
    expect(stages.join(' ')).toMatch(/Read-only check/i);
  });

  it('flags a refused write instead of reporting an answer', async () => {
    await page.click('[data-close]');
    server.setReply('DELETE FROM orders');
    await askInUi('delete the refunded orders');

    const flag = await page.textContent('.flag');
    expect(flag).toMatch(/read-only|refused/i);
    expect(await page.$('.ansrows')).toBeNull();
  });

  it('flags an unanswerable question instead of inventing a number', async () => {
    server.setReply('CANNOT_ANSWER: there is no column describing customer sentiment');
    await askInUi('how happy were my customers?');

    const flag = await page.textContent('.flag');
    expect(flag).toContain('sentiment');
    expect(await page.$('.ansrows')).toBeNull();
  });

  it('runs hand-written SQL in the SQL view, with the same guard', async () => {
    await page.click('[data-nav="sql"]');
    await page.waitForSelector('.sqled textarea');

    await page.fill('.sqled textarea', 'SELECT count(*) AS n FROM orders');
    await page.click('[data-runsql]');
    await expect.poll(async () => page.textContent('.sqlres')).toContain('6');

    await page.fill('.sqled textarea', 'DELETE FROM orders');
    await page.click('[data-runsql]');
    await expect.poll(async () => page.textContent('.sqlres')).toMatch(/READ_ONLY_VIOLATION|read-only/i);
  });

  it('lists model tiers in the Models view without revealing any key', async () => {
    await page.click('[data-nav="models"]');
    await page.waitForSelector('.models');

    const text = await page.textContent('.models');
    expect(text).toMatch(/Bundled|local/i);
    expect(text).toContain('llama3.1:8b');
    // The honest caveat spec §9 requires, stated where the choice is made.
    expect(text).toMatch(/smaller local models|weaker SQL/i);
  });
});
