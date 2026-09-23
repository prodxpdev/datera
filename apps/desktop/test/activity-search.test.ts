import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, startStubModelServer, type FixturePaths, type StubModelServer } from '@datera/testkit';

/**
 * Searching the request log, in SQL and in words (§12.9a).
 *
 * The spec asks for both, "with the SQL shown". SQL worked because the log is an ordinary
 * dataset, so the Query editor already reached it — but there was no way in from Activity,
 * which is where someone actually looking at a request would think to ask. Asking in words
 * did not work at all: the schema handed to the model came only from a dataset's *sources*,
 * and the log has none.
 *
 * The SQL being shown is the part that matters most here. An answer about what Datera did,
 * which you have to take on faith, would undercut the reason the log exists.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('searching the activity log', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;
  let model: StubModelServer;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    model = await startStubModelServer();
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-activitysearch-'));

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

    await page.evaluate(
      async ({ csv, endpoint }: { csv: string; endpoint: string }) => {
        const datera = (globalThis as unknown as {
          datera: {
            addSource(r: unknown): Promise<unknown>;
            setChatModel(m: unknown): Promise<unknown>;
            query(d: string, s: string): Promise<unknown>;
          };
        }).datera;
        await datera.addSource({ type: 'file', path: csv, name: 'orders' });
        await datera.setChatModel({
          tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
          locality: 'local', endpoint, label: 'llama3.1:8b',
        });
        // Something for the log to contain.
        await datera.query('ungrouped', 'SELECT count(*) FROM orders');
      },
      { csv: fixtures.ordersCsv, endpoint: model.url },
    );

    await page.reload();
    await page.waitForSelector('.srcitem', { timeout: 30_000 });
    await page.click('[data-nav="activity"]');
    await page.waitForSelector('[data-serve="log"]', { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await closeApp(app);
    await model.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('offers a way to ask the log a question, where the log is', async () => {
    // Not in the Query editor two views away: someone reading a request log and wondering
    // "what was slowest today" should be able to ask it here.
    expect(await page.isVisible('[data-log-ask]')).toBe(true);
  });

  it('answers in words and shows the SQL it ran', async () => {
    model.setReply('SELECT question, total_ms FROM requests ORDER BY total_ms DESC LIMIT 5');

    await page.fill('[data-log-ask]', 'which requests were slowest?');
    await page.click('[data-log-ask-go]');

    await page.waitForSelector('[data-log-ask-sql]', { timeout: 60_000 });
    const shown = await page.textContent('[data-log-ask-sql]');
    expect(shown).toContain('FROM requests');

    // The rows, not only the statement — an answer that shows its SQL but no result is
    // not an answer.
    const rows = await page.locator('[data-log-ask-rows] tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  it('says so when it cannot answer, rather than showing an empty table', async () => {
    model.setReply('CANNOT_ANSWER: the log does not record that');

    await page.fill('[data-log-ask]', 'what did the user have for lunch');
    await page.click('[data-log-ask-go]');

    await expect
      .poll(async () => page.textContent('.serve'), { timeout: 60_000 })
      .toMatch(/could not|cannot|no answer/i);
  });
});
