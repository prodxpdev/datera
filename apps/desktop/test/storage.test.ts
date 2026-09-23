import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, type FixturePaths } from '@datera/testkit';

/**
 * What Datera has put on this machine, and getting rid of it.
 *
 * A local-first tool's claim is that your data stays with you. The question people
 * actually test that claim with is "can I see what it stored, and remove it?" — and
 * dragging the app to the Trash answers neither: it leaves gigabytes behind in a
 * directory most people never open. A stale userData directory from a renamed build sat
 * on this developer's machine for over a week without anyone noticing, which is the same
 * problem in miniature.
 *
 * So: itemised, with real sizes, each removable on its own.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

interface StorageItem {
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly destroysData: boolean;
}

describe('what Datera has stored', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;

  const storage = async (): Promise<readonly StorageItem[]> =>
    page.evaluate(async () =>
      (globalThis as unknown as { datera: { storageUsage(): Promise<StorageItem[]> } })
        .datera.storageUsage(),
    );

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-storage-'));

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
  }, 120_000);

  afterAll(async () => {
    await closeApp(app);
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('accounts for the workspace, with a real size rather than a guess', async () => {
    const items = await storage();
    const workspace = items.find((i) => i.id === 'workspace');

    expect(workspace).toBeDefined();
    // A source has been connected, so this is not an empty database.
    expect(workspace!.bytes).toBeGreaterThan(0);
  });

  it('names every location it knows about, so nothing is stored invisibly', async () => {
    const ids = (await storage()).map((i) => i.id);

    // The three that actually take space, and the caches that surprise people.
    expect(ids).toContain('workspace');
    expect(ids).toContain('models');
    expect(ids).toContain('extensions');
    expect(ids).toContain('caches');
  });

  it('says which removals destroy data and which do not', async () => {
    // The distinction the UI needs to make loudly. Clearing a cache costs a re-download;
    // clearing the workspace costs the work.
    const items = await storage();

    expect(items.find((i) => i.id === 'workspace')?.destroysData).toBe(true);
    expect(items.find((i) => i.id === 'caches')?.destroysData).toBe(false);
    expect(items.find((i) => i.id === 'models')?.destroysData).toBe(false);
  });

  it('removes one item without taking the data with it', async () => {
    await page.evaluate(async () =>
      (globalThis as unknown as { datera: { removeStorage(id: string): Promise<unknown> } })
        .datera.removeStorage('caches'),
    );

    // Asserted on the data rather than on a byte count. Under DATERA_HEADLESS the app's
    // userData sits *inside* the workspace directory, so the caches are nested within it
    // and clearing them legitimately changes its size — a layout that only exists in
    // tests. What must hold everywhere is that the workspace still answers.
    const rows = await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { query(d: string, s: string): Promise<{ rows: unknown[][] }> };
      }).datera.query('ungrouped', 'SELECT count(*) AS n FROM orders'),
    );
    expect(Number(rows.rows[0]![0])).toBeGreaterThan(0);

    const after = await storage();
    expect(after.find((i) => i.id === 'workspace')?.bytes).toBeGreaterThan(0);
  });

  it('does not fail when a file is in use, because on Windows they always are', async () => {
    // Windows locks files a running process holds open, so unlinking Chromium's own
    // GPUCache while the window is up fails with EPERM — which threw, and took the whole
    // panel with it. A user clearing caches in a live app is the normal case, not an edge
    // one, so being unable to delete a file cannot be an error.
    //
    // Simulated here with a directory nothing can unlink within, which is the closest
    // POSIX equivalent of a held file handle.
    const stuck = join(workspacePath, '.profile', 'Cache', 'stuck');
    await mkdir(stuck, { recursive: true });
    await writeFile(join(stuck, 'held'), 'in use');
    await chmod(stuck, 0o555);

    try {
      const result = await page.evaluate(async () =>
        (globalThis as unknown as {
          datera: { removeStorage(id: string): Promise<{ remaining: number }> };
        }).datera.removeStorage('caches'),
      );

      // It reports what it could not remove rather than throwing, so the UI can say the
      // rest goes on restart.
      expect(result.remaining).toBeGreaterThan(0);
    } finally {
      await chmod(stuck, 0o755);
      await rm(stuck, { recursive: true, force: true });
    }
  });

  it('leaves the window usable after clearing a cache', async () => {
    // Clearing a cache must be visible as nothing but a cache clear. The first attempt
    // here also called session.clearStorageData(), which wipes localStorage as well —
    // app state, not cache — and the Settings panel became unopenable on Linux. The
    // narrower clearCache() is the one that releases the handles Windows locks.
    await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { removeStorage(id: string): Promise<{ remaining: number }> };
      }).datera.removeStorage('caches'),
    );

    // The navigation still responds, which is what "unopenable" broke.
    expect(await page.isVisible('[data-nav="activity"]')).toBe(true);
    await page.click('[data-nav="activity"]');
    await page.waitForSelector('[data-serve="log"]', { timeout: 30_000 });
  });

  it('reports nothing remaining when it removed everything', async () => {
    const result = await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { removeStorage(id: string): Promise<{ remaining: number }> };
      }).datera.removeStorage('extensions'),
    );
    expect(result.remaining).toBe(0);
  });

  it('refuses an id it does not recognise, rather than deleting something adjacent', async () => {
    const result = await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { removeStorage(id: string): Promise<unknown> };
      }).datera.removeStorage('../../../etc').then(() => 'allowed').catch((e: Error) => e.message),
    );

    expect(result).not.toBe('allowed');
  });

  it('shows every location in Settings, with its size', async () => {
    await page.click('[data-nav="settings"]');
    await page.click('[data-settab="privacy"]');
    await page.waitForSelector('[data-storage-panel]', { timeout: 30_000 });

    for (const id of ['workspace', 'models', 'extensions', 'caches']) {
      expect(await page.isVisible(`[data-storage-item="${id}"]`)).toBe(true);
      // A size, in units a person reads — not a byte count and not a guess.
      expect(await page.textContent(`[data-storage-size="${id}"]`)).toMatch(/^\d+(\.\d+)? (B|KB|MB|GB)$/);
    }
  });

  it('asks before removing anything, and says what is about to go', async () => {
    // One click must not delete a workspace. The confirmation names the consequence
    // rather than asking "are you sure?", which is a question nobody reads.
    await page.click('[data-storage-remove="workspace"]');

    const confirm = await page.textContent('[data-storage-confirm="workspace"]');
    expect(confirm).toMatch(/delete my work/i);

    // And it is escapable.
    await page.click('text=cancel');
    expect(await page.isVisible('[data-storage-confirm="workspace"]')).toBe(false);
  });

  it('gates removing everything behind its own confirmation', async () => {
    await page.click('[data-remove-all]');
    expect(await page.isVisible('[data-remove-all-confirm]')).toBe(true);
    await page.click('text=cancel');
    expect(await page.isVisible('[data-remove-all-confirm]')).toBe(false);
  });

  it('resets settings without touching the data', async () => {
    await page.click('[data-reset-settings]');

    await expect.poll(async () => page.textContent('[data-storage-done]'), { timeout: 30_000 })
      .toMatch(/defaults/i);

    // The distinction the whole panel rests on: settings went, data stayed.
    const rows = await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { query(d: string, s: string): Promise<{ rows: unknown[][] }> };
      }).datera.query('ungrouped', 'SELECT count(*) AS n FROM orders'),
    );
    expect(Number(rows.rows[0]![0])).toBeGreaterThan(0);
  });

  it('tells you the one step it cannot do for you', async () => {
    // Removing the application bundle is the operating system's job, and differs per
    // platform. Saying so is the difference between a complete answer and a dead end.
    const instruction = await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { removalInstruction(): Promise<string> };
      }).datera.removalInstruction(),
    );

    expect(instruction).toMatch(/Applications|Trash|apt|Add or remove|Program/i);
  });
});
