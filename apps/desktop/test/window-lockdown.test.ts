import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeApp, removeWorkspace } from './close-app.js';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * The window cannot be navigated away from the app.
 *
 * `contextIsolation`, `sandbox` and `nodeIntegration: false` protect the renderer from
 * Node — they do nothing about the renderer being pointed at a *different document*. A
 * preload script is attached per webContents, so it survives navigation: send the window
 * to an attacker's HTML file and that file gets `window.dateraBridge` with the entire
 * surface on it. Arbitrary file read via addSource, arbitrary SQL against the workspace,
 * and the serving token, all from a page that is not ours.
 *
 * No exploit of the renderer is needed to trigger it. Chromium's default response to a
 * file dropped on a page is to navigate the frame to it, so "open this report" is the
 * whole attack.
 *
 * These assertions were written against a confirmed working exploit: before the fix,
 * every one of them failed.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('the window stays on the app', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let hostile: string;

  beforeAll(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-lockdown-'));
    hostile = join(workspacePath, 'hostile.html');
    await writeFile(hostile, '<!doctype html><title>hostile</title><p>not the app</p>');

    app = await electron.launch({
      args: [appRoot],
      env: {
        ...process.env,
        DATERA_WORKSPACE: workspacePath,
        DATERA_HEADLESS: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.brand', { timeout: 60_000 });
  }, 120_000);

  afterAll(async () => {
    await closeApp(app);
    await removeWorkspace(workspacePath);
  });

  it('refuses to open a second window', async () => {
    const opened = await page.evaluate(() => {
      const w = window.open('https://example.com', '_blank');
      return w !== null;
    });
    expect(opened).toBe(false);

    // And no second BrowserWindow exists, which is the thing that actually matters.
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(windows).toBe(1);
  });

  it('refuses to navigate itself to a local file', async () => {
    const before = page.url();
    await page.evaluate((url: string) => {
      location.href = url;
    }, pathToFileURL(hostile).href);
    await page.waitForTimeout(700);

    expect(page.url()).toBe(before);
    // The app is still the app: its own markup is still on screen.
    expect(await page.isVisible('.brand')).toBe(true);
  });

  it('refuses to navigate itself to a remote page', async () => {
    const before = page.url();
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await page.waitForTimeout(700);
    expect(page.url()).toBe(before);
  });

  it('keeps the bridge off any document that is not the app', async () => {
    // The consequence, stated directly. If navigation is ever allowed again, this is the
    // assertion that should fail.
    const stillOurs = await page.evaluate(() => location.protocol === 'file:' && document.querySelector('.brand') !== null);
    expect(stillOurs).toBe(true);
  });

  it('ignores a file dropped on the window', async () => {
    // Chromium navigates to a dropped file by default. A guard that only covered
    // window.open would leave the likeliest route wide open.
    const prevented = await page.evaluate(() => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });
});
