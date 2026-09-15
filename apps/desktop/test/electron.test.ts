import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, fingerprintFile, type FixturePaths } from '@datera/testkit';

/**
 * P1-18 + P1-19 — the Electron shell, driven for real.
 *
 * P1-18 exists because "Node-API means no ABI rebuild" is a reasonable expectation, not a
 * fact, until the native DuckDB addon has actually been loaded inside a running Electron
 * main process. Discovering otherwise at Phase 7 packaging time would be expensive.
 *
 * P1-19 is acceptance §12.1 proven through the real shell rather than in a unit test: the
 * app connects a fixture, shows its schema and rows, and the file is byte-identical after.
 */

const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('P1-18/P1-19 Electron shell', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-electron-'));

    app = await electron.launch({
      args: [appRoot],
      env: {
        ...process.env,
        DATERA_WORKSPACE: workspacePath,
        // DATERA_EXTENSION_DIR is deliberately NOT set. Setting it here once hid a real
        // bug: the app's own resolution guessed <appRoot>/vendor, which does not exist in
        // a workspace layout, so a normally-launched app loaded no extensions at all. A
        // test that pins the thing it is meant to exercise is not testing it.
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    });

    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('launches and loads DuckDB inside the Electron main process', async () => {
    // The P1-18 assertion. If the native addon needed an Electron-specific rebuild, this
    // is where it would fail — in a cheap test, rather than during packaging.
    const info = await app.evaluate(async () => {
      // Runs in the main process.
      return { version: process.versions.electron, platform: process.platform };
    });
    expect(info.version).toBeTruthy();

    await page.waitForSelector('.brand', { timeout: 60_000 });
    const engineFooter = await page.textContent('.side .foot');
    expect(engineFooter).toContain('DuckDB v');
    expect(engineFooter).toContain('duckdb-node-api');
  });

  it('finds and loads its staged extensions without being told where they are', async () => {
    // Regression guard. The app resolves the extension directory itself here — no
    // DATERA_EXTENSION_DIR — because that is what happens when a person launches it.
    // Without every extension loaded, .xlsx and SQLite are unavailable.
    const extensions = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { engineInfo(): Promise<{ extensions: { name: string; loaded: boolean }[] }> };
      }).datera;
      const info = await api.engineInfo();
      return info.extensions.filter((e) => e.loaded).map((e) => e.name);
    });

    expect(extensions).toContain('excel');
    expect(extensions).toContain('sqlite_scanner');
    expect(extensions).toContain('postgres_scanner');
    expect(extensions).toContain('mysql_scanner');
  });

  it('isolates the renderer from Node and from the core', async () => {
    const probe = await page.evaluate(() => ({
      hasRequire: typeof (globalThis as Record<string, unknown>)['require'] !== 'undefined',
      hasProcess: typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined',
      hasModule: typeof (globalThis as Record<string, unknown>)['module'] !== 'undefined',
      bridgeKeys: Object.keys((globalThis as unknown as { dateraBridge?: object }).dateraBridge ?? {}).sort(),
    }));

    // No Node in the renderer, and the only route to the engine is the named bridge.
    expect(probe.hasRequire).toBe(false);
    expect(probe.hasProcess).toBe(false);
    expect(probe.hasModule).toBe(false);
    expect(probe.bridgeKeys).toEqual([
      'addSource', 'engineInfo', 'getSchema', 'listDatasets', 'listSources',
      'pickFiles', 'preview', 'query', 'removeSource',
    ]);
  });

  it('shows the empty state before anything is connected', async () => {
    await expect.poll(async () => page.textContent('.empty h2')).toContain('No sources connected');
  });

  it('connects a CSV through the bridge, and shows its schema and rows', async () => {
    // Driving through `window.datera` rather than the OS file dialog: the dialog is native
    // and cannot be scripted, and what is under test is the shell's own path from bridge
    // to engine to rendered rows.
    const path = fixtures.ordersCsv;
    const before = await fingerprintFile(path);

    await page.evaluate(async (p: string) => {
      const api = (globalThis as unknown as { datera: { addSource(r: unknown): Promise<unknown> } }).datera;
      await api.addSource({ type: 'file', path: p, name: 'orders' });
    }, path);

    await page.reload();
    await page.waitForSelector('.srcitem', { timeout: 30_000 });

    expect(await page.textContent('.srcitem .nm')).toBe('orders');

    // Schema chips carry the real DuckDB types. Polled, because schema and preview load
    // after the source list renders.
    await expect
      .poll(async () => (await page.$$eval('.schip', (els) => els.map((e) => e.textContent ?? ''))).join(' '), {
        timeout: 30_000,
      })
      .toContain('BIGINT');

    const chips = await page.$$eval('.schip', (els) => els.map((e) => e.textContent ?? ''));
    expect(chips.join(' ')).toContain('revenue_cents');

    // And the preview shows actual rows.
    await expect.poll(async () => page.textContent('.prev tbody tr td'), { timeout: 30_000 }).toBe('A-1042');

    const rowCount = await page.$$eval('.prev tbody tr', (els) => els.length);
    expect(rowCount).toBe(6);

    // The read-only badge is present, because it is a promise the UI makes.
    expect(await page.textContent('.readonly')).toContain('read-only');

    // P1-19 / §12.1 through the real shell: the file is untouched.
    const after = await fingerprintFile(path);
    expect(after.sha256).toBe(before.sha256);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('surfaces a read-only violation with its code, through the IPC boundary', async () => {
    // The code has to survive marshalling: the UI needs it to tell "read-only" from
    // "file moved", and Electron would otherwise flatten the error to a bare message.
    const result = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { query(d: string, s: string): Promise<unknown> };
      }).datera;
      try {
        await api.query('ungrouped', 'DELETE FROM orders');
        return { threw: false, code: null as string | null };
      } catch (e) {
        return { threw: true, code: (e as { code?: string }).code ?? null };
      }
    });

    expect(result.threw).toBe(true);
    expect(result.code).toBe('READ_ONLY_VIOLATION');
  });

  it('runs a read query through the shell', async () => {
    const rows = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { query(d: string, s: string): Promise<{ rows: unknown[][] }> };
      }).datera;
      const result = await api.query('ungrouped', 'SELECT count(*) AS n FROM orders');
      return result.rows;
    });

    expect(Number(rows[0]?.[0])).toBe(6);
  });
});
