import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { fixturePaths } from '@datera/testkit';

/**
 * Does the *packaged* app actually work?
 *
 * Nothing asked this before, and the answer was no. The build shipped the JavaScript and
 * left the DuckDB native binding behind — pnpm keeps a platform binding in its own
 * isolated tree, and the packager only walked the app's own node_modules. A packaged
 * Datera could not open a workspace at all.
 *
 * It went unnoticed because the only packaging assertions were about the bundle's
 * Info.plist: the name and the icon were checked, and whether the thing ran was not. A
 * build that produces a correctly-named app which cannot start is worse than no build.
 *
 * Opt-in — `DATERA_PACKAGED=1` — because it needs a packaging run first
 * (`pnpm --filter @datera/desktop package`), which takes minutes and downloads an Electron
 * distribution. Skipped rather than silently absent: the skip is visible in the output.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const packagedApp = join(appRoot, 'release/mac-arm64/Datera.app/Contents/MacOS/Datera');

const runnable = process.env['DATERA_PACKAGED'] === '1' && existsSync(packagedApp);

describe.runIf(runnable)('the packaged app', () => {
  let app: ElectronApplication;
  let workspacePath: string;

  afterAll(async () => {
    await closeApp(app);
    if (workspacePath !== undefined) await rm(workspacePath, { recursive: true, force: true });
  });

  it('starts, opens a workspace, and reads a real file', async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-packaged-'));
    const fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);

    app = await electron.launch({
      executablePath: packagedApp,
      args: [],
      env: {
        ...process.env,
        DATERA_WORKSPACE: workspacePath,
        DATERA_HEADLESS: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    });

    const page = await app.firstWindow();
    await page.waitForSelector('.brand', { timeout: 60_000 });

    // The assertion that would have caught it: DuckDB loaded inside the packaged app.
    const engine = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { engineInfo(): Promise<{ duckdbVersion: string; extensions: { name: string; loaded: boolean }[] }> };
      }).datera;
      return api.engineInfo();
    });
    expect(engine.duckdbVersion).toMatch(/^v?\d/);

    // And the staged extensions travelled with it. Without these, .xlsx and SQLite stop
    // working in a packaged build and nowhere else — the worst kind of difference.
    const loaded = engine.extensions.filter((e) => e.loaded).map((e) => e.name);
    expect(loaded).toContain('excel');
    expect(loaded).toContain('sqlite_scanner');

    const rows = await page.evaluate(async (path: string) => {
      const api = (globalThis as unknown as {
        datera: {
          addSource(r: unknown): Promise<unknown>;
          query(d: string, s: string): Promise<{ rows: unknown[][] }>;
        };
      }).datera;
      await api.addSource({ type: 'file', path, name: 'orders' });
      return (await api.query('ungrouped', 'SELECT count(*) FROM orders')).rows;
    }, fixtures.ordersCsv);

    expect(Number(rows[0]?.[0])).toBeGreaterThan(0);
  }, 180_000);

  it('carries the local model runtime, not just the database', async () => {
    // Reported from the installed app: clicking a suggestion produced
    // NoBinaryFoundError. llama.cpp ships its binary in a platform package exactly as
    // DuckDB does, and only DuckDB had been declared — so the JavaScript shipped and the
    // binary did not. The same bug, missed because this test only ever asked about the
    // database.
    //
    // status() loads the runtime far enough to answer, which is the part that was
    // failing, without needing gigabytes of weights present.
    // The app is already running from the test above; firstWindow returns that window.
    const page = await app.firstWindow();
    const statuses = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { listModels(): Promise<{ bundled: { modelId: string }[] }> };
      }).datera;
      return (await api.listModels()).bundled.map((m) => m.modelId);
    });

    expect(statuses.length).toBeGreaterThan(0);

    const binary = await app.evaluate(async ({ app: electronApp }) => {
      const { existsSync, readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dir = join(
        electronApp.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
        'node_modules/@node-llama-cpp',
      );
      return existsSync(dir) ? readdirSync(dir) : [];
    });

    expect(binary, 'no @node-llama-cpp platform package in the packaged app').not.toEqual([]);
  }, 120_000);
});
