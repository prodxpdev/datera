import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, type FixturePaths } from '@datera/testkit';

/**
 * Exporting, through the app (§1.8, §12.11).
 *
 * This had no end-to-end coverage because it begins with a native folder dialog, which a
 * test cannot drive — so the whole path from button to files on disk was verified only in
 * core. A reported "exports are all failing" could not be reproduced against either,
 * which is the position an untested seam puts you in.
 *
 * The main process now answers the dialog from DATERA_TEST_DIRECTORY when headless, so
 * the real path runs: click, IPC, core, files.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('export from the app', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let exportDir: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-exportui-'));
    exportDir = await mkdtemp(join(tmpdir(), 'datera-exported-'));

    app = await electron.launch({
      args: [appRoot],
      env: {
        ...process.env,
        DATERA_WORKSPACE: workspacePath,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        DATERA_HEADLESS: '1',
        DATERA_TEST_DIRECTORY: exportDir,
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
    await page.click('[data-nav="data"]');
    await page.click('[data-data="shape"]');
    await page.waitForSelector('.shape', { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
  });

  it('exports parquet, and the files are actually there', async () => {
    await page.click('text=Export as parquet');
    await expect
      .poll(async () => (await readdir(exportDir)).some((f) => f.endsWith('.parquet')), { timeout: 60_000 })
      .toBe(true);

    // Polled, not asserted directly: the files land before React has re-rendered the
    // status line, so reading it immediately after the files appear is a race that only
    // shows up on a slower machine.
    await expect.poll(async () => page.textContent('.shape'), { timeout: 30_000 })
      .toMatch(/Exported \d+ file/);

    const written = await readdir(exportDir);
    expect(written.some((f) => f.endsWith('.parquet'))).toBe(true);
    // §1.8: the data is not the whole artifact. Schema, dictionary and dataset definition
    // travel with it, or "no lock-in" is a slogan.
    expect(written).toContain('datera-export.json');
    expect(written.some((f) => f.endsWith('.sql'))).toBe(true);
  });

  it('exports csv too, for tools that cannot read parquet', async () => {
    await page.click('text=Export as csv');

    // Polled on the files, not on the status line: the line still shows the previous
    // export's message, so a text poll matches instantly and then asserts against a
    // directory the export has not finished writing.
    await expect
      .poll(async () => (await readdir(exportDir)).some((f) => f.endsWith('.csv')), { timeout: 60_000 })
      .toBe(true);
  });

  it('says so when the folder choice is cancelled, rather than doing nothing', async () => {
    // The one real bug found while chasing the original report: cancelling the dialog was
    // a silent no-op, which from the outside is indistinguishable from a failed export.
    await app.evaluate(async () => {
      process.env['DATERA_TEST_DIRECTORY'] = '';
    });

    await page.click('text=Export as parquet');
    await expect.poll(async () => page.textContent('.shape'), { timeout: 30_000 })
      .toMatch(/cancelled/i);
  });

  it('reports a real failure as an error, not as success', async () => {
    // A path *inside a file*, which no operating system can create a directory under.
    // '/definitely/not/a/writable/path' is unwritable on macOS and Linux and perfectly
    // creatable on Windows, where the export then succeeded and the test failed.
    const blocked = join(exportDir, 'a-file.txt', 'inside');
    await writeFile(join(exportDir, 'a-file.txt'), 'not a directory');
    // The first parameter of an ElectronApplication.evaluate callback is the electron
    // module; the payload is the second.
    await app.evaluate(async (_electron, target: string) => {
      process.env['DATERA_TEST_DIRECTORY'] = target;
    }, blocked);

    await page.click('text=Export as parquet');
    await expect.poll(async () => page.textContent('.shape'), { timeout: 30_000 })
      .toMatch(/Export:/);
  });
});
