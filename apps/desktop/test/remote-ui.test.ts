import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { serveHttp, type RunningServer } from '@datera/cli';
import {
  fixturePaths, openTestWorkspace, testPorts,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * §12.10's second half: the same UI, driving a Datera Server.
 *
 * The criterion is "the client runs fully standalone with no server; when connected to a
 * Datera Server, the same UI drives it — assert both paths". The standalone path was
 * covered and the remote path was not: core asserted the *interface* matched, while the
 * desktop app could push a dataset to a server and check it was up, but never query one.
 * A remote dataset was somewhere you sent data, not somewhere you worked.
 *
 * A real server here — the same `serveHttp` the `datera` binary runs — over a real
 * socket, driven through the real UI.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('driving a Datera Server from the app', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let server: RunningServer;
  let remote: TestWorkspace;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);

    // The "server": a second workspace with its own data, served over HTTP.
    remote = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await remote.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    server = await serveHttp({
      datera: remote.datera,
      info: { name: 'datera', version: '0.1.0' },
      port: 0,
      log: () => {},
    });

    workspacePath = await mkdtemp(join(tmpdir(), 'datera-remote-'));
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

    await page.evaluate(async (url: string) => {
      await (globalThis as unknown as {
        datera: { addEnvironment(e: unknown): Promise<unknown> };
      }).datera.addEnvironment({ id: 'test', name: 'Test Server', url });
    }, `http://127.0.0.1:${server.port}`);

    await page.reload();
    await page.waitForSelector('.brand', { timeout: 30_000 });
  }, 180_000);

  afterAll(async () => {
    await closeApp(app);
    await server?.close();
    await remote?.dispose();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('offers the server’s datasets in the same picker as local ones', async () => {
    // A separate "remote mode" would be a second product. §12.10 says the same UI.
    await expect
      .poll(async () => page.textContent('[data-dataset-switch]'), { timeout: 30_000 })
      .toMatch(/Test Server/);
  });

  it('queries the remote dataset through the ordinary editor', async () => {
    const value = await page.$eval('[data-dataset-switch] optgroup option', (el) =>
      (el as HTMLOptionElement).value,
    );
    await page.selectOption('[data-dataset-switch]', value);
    await page.click('[data-nav="query"]');
    await page.waitForSelector('[data-sql]');

    await page.fill('[data-sql]', 'SELECT count(*) AS n FROM orders');
    await page.click('[data-runsql]');

    await expect.poll(async () => page.textContent('.sqlres'), { timeout: 30_000 }).toMatch(/\d/);
  });

  it('says where the statement ran, rather than letting it look local', async () => {
    const scope = await page.textContent('[data-scope]');
    expect(scope).toMatch(/Test Server/);
    expect(scope).toMatch(/enforced there rather than here/i);
  });

  it('carries the server’s read-only refusal back to the same UI', async () => {
    // The guard runs on the server. A client-side check would be advice; this is the
    // guarantee, and the client must show the refusal rather than swallow it.
    await page.fill('[data-sql]', 'DELETE FROM orders');
    await page.click('[data-runsql]');

    await expect.poll(async () => page.textContent('.query'), { timeout: 30_000 })
      .toMatch(/read-only|READ_ONLY_VIOLATION|refused/i);
  });

  it('still works with the server gone — the standalone half of §12.10', async () => {
    await server.close();
    await page.reload();
    await page.waitForSelector('.brand', { timeout: 30_000 });

    // Local datasets are still listed and still queryable. A server being unreachable is
    // a normal condition, not a broken workspace.
    await page.click('[data-nav="query"]');
    await page.waitForSelector('[data-sql]', { timeout: 30_000 });
    expect(await page.textContent('[data-dataset-switch]')).toMatch(/Ungrouped/);
  });
});
