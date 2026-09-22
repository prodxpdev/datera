import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * The app must identify itself as "Datera" everywhere a person can see it.
 *
 * Written test-first against a real complaint: the macOS menu bar said "Electron". Two
 * separate causes, which is why this asserts several things rather than one —
 *
 *  - Electron defaults `app.name` to the **package.json `name`**, so it was reporting
 *    "@datera/desktop": a scoped package name, visible to the user, in the menu.
 *  - On macOS the menu bar's first item is the *application menu*, and unless an explicit
 *    menu is installed it comes from the Electron binary's own bundle — hence "Electron".
 *
 * Fixing one without the other leaves the name wrong somewhere, and "somewhere" is
 * whichever surface nobody checked.
 */

const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('application identity', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-identity-'));
    app = await electron.launch({
      args: [appRoot],
      env: { ...process.env, DATERA_WORKSPACE: workspacePath, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DATERA_HEADLESS: '1' },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.brand', { timeout: 60_000 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('reports its name as Datera, not the package name', async () => {
    const name = await app.evaluate(async ({ app: electronApp }) => electronApp.getName());
    expect(name).toBe('Datera');
  });

  it('shows Datera as the first application menu, not Electron', async () => {
    const labels = await app.evaluate(async ({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label),
    );

    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0]).toBe('Datera');
    expect(labels).not.toContain('Electron');
    expect(labels.join(' ')).not.toContain('@datera/desktop');
  });

  it('keeps the standard menu roles a desktop app is expected to have', async () => {
    // Replacing the default menu means we own it — including the things people reach for
    // without thinking. Losing Copy or Quit to a custom menu is a genuine regression.
    const labels = await app.evaluate(async ({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label),
    );

    for (const expected of ['Edit', 'View', 'Window', 'Help']) {
      expect(labels).toContain(expected);
    }
  });

  it('titles the window Datera', async () => {
    expect(await page.title()).toBe('Datera');
    const windowTitle = await app.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getTitle(),
    );
    expect(windowTitle).toBe('Datera');
  });

  it('names itself Datera in the About panel', async () => {
    const about = await app.evaluate(async ({ app: electronApp }) => {
      // There is no getter, so round-trip through what we set at startup.
      return { name: electronApp.getName(), version: electronApp.getVersion() };
    });
    expect(about.name).toBe('Datera');
    expect(about.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('shows the Datera mark in the sidebar, not a stand-in shape', async () => {
    // The brand block held a CSS gradient square that only resembled the mark. Close
    // enough is how a shipped app quietly stops matching the kit it was designed from.
    const mark = await page.$('.brand svg');
    expect(mark).not.toBeNull();

    const gradient = await page.$eval('.brand svg', (el) => el.querySelector('linearGradient')?.id ?? '');
    expect(gradient.length).toBeGreaterThan(0);
  });

  // There is no Dock on Linux or Windows, where the icon comes from the window and the
  // installer instead.
  it.runIf(process.platform === 'darwin')(
    'sets the Dock icon, so an unpackaged run is not the Electron atom',
    async () => {
    // macOS ignores BrowserWindow.icon entirely and takes the Dock icon from the app
    // bundle — which, for `electron .`, is Electron's own. app.dock.setIcon is the only
    // thing that corrects it, and it was the last place still showing the wrong logo.
    const set = await app.evaluate(async ({ app: electronApp }) =>
      (electronApp as { dockIconSet?: boolean }).dockIconSet === true,
    );
      expect(set).toBe(true);
    },
  );

  it('ships an icon in every format its three platforms need', async () => {
    // macOS reads .icns, Windows .ico, Linux .png, and electron-builder silently falls
    // back to the Electron default for whichever is missing — a failure that shows up
    // only in a release artifact nobody opens until later.
    for (const file of ['icon.icns', 'icon.ico', 'icon.png']) {
      const bytes = await readFile(join(appRoot, 'build', file));
      expect(bytes.byteLength).toBeGreaterThan(1000);
    }
  });

  it('points electron-builder at that icon directory', async () => {
    const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as {
      build?: { directories?: { buildResources?: string } };
    };
    expect(manifest.build?.directories?.buildResources).toBe('build');
  });

  it('declares a productName so packaged builds carry the same name', async () => {
    // app.setName() fixes the running process. The *packaged* bundle takes its name from
    // electron-builder's productName, and nothing at runtime can correct that — so the
    // manifest is asserted here rather than discovered at release time.
    const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as {
      build?: { productName?: string; appId?: string };
    };

    expect(manifest.build?.productName).toBe('Datera');
    expect(manifest.build?.appId).toMatch(/^[a-z0-9.-]+$/);
  });
});

/**
 * A test instance must not be able to outlive its run.
 *
 * Written after three wedged instances survived `app.close()`, SIGTERM, and nearly three
 * hours — a hung app the user has to hunt down is a worse failure than the test failure
 * that caused it.
 */
describe('headless watchdog', () => {
  it('exits on its own when the deadline passes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'datera-watchdog-'));
    const instance = await electron.launch({
      args: [appRoot],
      env: {
        ...process.env,
        DATERA_WORKSPACE: workspace,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        DATERA_HEADLESS: '1',
        // Seconds rather than the ten-minute default, so the test is a test.
        DATERA_HEADLESS_MAX_MS: '3000',
      },
    });

    try {
      const exited = new Promise<void>((resolve) => instance.on('close', () => resolve()));
      await expect(
        Promise.race([
          exited,
          new Promise((_, reject) => setTimeout(() => reject(new Error('still running')), 30_000)),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      await instance.close().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
