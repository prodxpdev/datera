import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, type FixturePaths } from '@datera/testkit';

/**
 * The layout must not overflow horizontally, at any window width.
 *
 * Written test-first, against a real bug: a wide CSV (many columns, long timestamps, a
 * long file path) pushed the schema chips, the preview table, the read-only badge and the
 * detection panel past the right edge of the window, where they were simply unreachable.
 *
 * The cause is the classic CSS grid trap — a `1fr` track will not shrink below its
 * content's min-content width, so a wide table silently widens the whole page instead of
 * scrolling inside its own container. `minmax(0, 1fr)` is the fix, and this test is what
 * stops it regressing, because the failure is invisible until someone opens a wide file.
 *
 * Asserted at several widths because the bug is width-dependent: at a comfortable window
 * everything fits and the page looks fine.
 */

const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Widths worth caring about: a small laptop, a common laptop, and a wide display. */
const WIDTHS = [900, 1100, 1280, 1680] as const;

/** BrowserWindow.minWidth. Requesting less than this silently gets this. */
const MIN_WINDOW_WIDTH = 900;

describe('Workspace layout is responsive', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-responsive-'));

    app = await electron.launch({
      args: [appRoot],
      env: { ...process.env, DATERA_WORKSPACE: workspacePath, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', DATERA_HEADLESS: '1' },
    });

    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.brand', { timeout: 60_000 });

    // A deliberately awkward source: many columns, wide values, and a long file path —
    // the shape that actually broke the layout.
    await page.evaluate(async (p: string) => {
      await (globalThis as unknown as { datera: { addSource(r: unknown): Promise<unknown> } }).datera.addSource({
        type: 'file',
        path: p,
        name: 'a_source_with_a_deliberately_long_name_20260421_1238',
      });
    }, fixtures.wideCsv);

    await page.reload();
    await page.waitForSelector('.prev tbody tr', { timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await closeApp(app);
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function setWidth(width: number): Promise<void> {
    await app.evaluate(async ({ BrowserWindow }, w: number) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setBounds({ x: 40, y: 40, width: w, height: 860 });
    }, width);
    // Wait for the resize to actually land, rather than for a fixed interval. A resize
    // crosses the main process, the compositor and a React render; 250ms was enough on a
    // quiet laptop and not on a loaded CI runner, where the assertion then measured the
    // *previous* width and failed as though the layout were broken.
    //
    // Clamped to the window's own minWidth: asking for 820 gets 900, which is still
    // narrow enough for the breakpoints under test but never becomes 820.
    const effective = Math.max(width, MIN_WINDOW_WIDTH);
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.clientWidth), {
        timeout: 15_000,
      })
      .toBeLessThanOrEqual(effective + 4);
  }

  it.each(WIDTHS)('does not scroll horizontally at %ipx', async (width) => {
    await setWidth(width);

    const overflow = await page.evaluate(() => ({
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
      bodyScroll: document.body.scrollWidth,
    }));

    // One pixel of tolerance for sub-pixel rounding; anything more is real overflow.
    expect(overflow.docScroll).toBeLessThanOrEqual(overflow.docClient + 1);
    expect(overflow.bodyScroll).toBeLessThanOrEqual(overflow.docClient + 1);
  });

  it.each(WIDTHS)('keeps every panel inside the window at %ipx', async (width) => {
    await setWidth(width);

    const escapees = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const selectors = ['.schips', '.prev', '.readonly', '.detail', '.dsbar', '.pager', '.banner'];
      const out: { selector: string; right: number; viewport: number }[] = [];

      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.right > viewport + 1) {
            out.push({ selector, right: Math.round(rect.right), viewport });
          }
        }
      }
      return out;
    });

    expect(
      escapees,
      escapees.map((e) => `${e.selector} extends to ${e.right}px in a ${e.viewport}px window`).join('; '),
    ).toEqual([]);
  });

  it.each(WIDTHS)('keeps every dictionary row action reachable at %ipx', async (width) => {
    await setWidth(width);
    await page.click('[data-nav="meaning"]');
    await page.waitForSelector('.dicttbl');

    // Draft the meanings first, or this test has no teeth: it is the long generated
    // sentence in the meaning column that widens the table, and an undrafted dictionary
    // shows a short placeholder that fits at any width.
    await page.click('[data-autodraft]');
    await expect
      .poll(async () => page.textContent('.dicttbl'), { timeout: 60_000 })
      .not.toMatch(/no meaning yet/);

    // The bug: the meaning column grew to fit its longest sentence, pushing Confirm and
    // Hide past the right edge — reachable only via a horizontal scrollbar macOS will not
    // draw until you are already scrolling, which you cannot start without the scrollbar.
    const clipped = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const out: number[] = [];
      for (const el of document.querySelectorAll('.rowacts .btn')) {
        const rect = el.getBoundingClientRect();
        if (rect.right > viewport + 1) out.push(Math.round(rect.right));
      }
      return { out, viewport };
    });

    expect(clipped.out, `buttons reach ${clipped.out.join(', ')}px in ${clipped.viewport}px`).toEqual([]);
    await page.click('[data-nav="data"]');
    await page.waitForSelector('.prev', { timeout: 30_000 });
  });

  it('scrolls a wide table inside its own container, not the page', async () => {
    await setWidth(1000);

    const table = await page.evaluate(() => {
      const el = document.querySelector('.prev');
      if (el === null) return null;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX };
    });

    expect(table).not.toBeNull();
    // The wide fixture genuinely does not fit, which is the point: it must overflow
    // *inside* the bordered container, where the user can scroll it.
    expect(table?.scrollWidth ?? 0).toBeGreaterThan(table?.clientWidth ?? 0);
    expect(table?.overflowX).toBe('auto');
  });

  it('wraps long detection values instead of pushing the layout wide', async () => {
    await setWidth(1000);

    const escapees = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      return [...document.querySelectorAll('.kv dd')]
        .map((el) => el.getBoundingClientRect().right)
        .filter((right) => right > viewport + 1);
    });

    expect(escapees).toEqual([]);
  });

  it('collapses the sidebar to icons on a narrow window', async () => {
    await setWidth(820);

    const sidebar = await page.evaluate(() => {
      const label = document.querySelector('.nav span:not(.ic)');
      const side = document.querySelector('.side');
      return {
        width: side === null ? 0 : Math.round(side.getBoundingClientRect().width),
        labelVisible: label === null ? false : getComputedStyle(label).display !== 'none',
      };
    });

    // Narrow windows give the data the room, not the chrome.
    expect(sidebar.width).toBeLessThan(120);
    expect(sidebar.labelVisible).toBe(false);
  });

  it('stacks the dataset rail above the detail on a narrow window', async () => {
    await setWidth(820);

    const stacked = await page.evaluate(() => {
      const grid = document.querySelector('.wsgrid');
      if (grid === null) return null;
      const [rail, detail] = [...grid.children].map((c) => c.getBoundingClientRect());
      if (rail === undefined || detail === undefined) return null;
      return { railBottom: rail.bottom, detailTop: detail.top };
    });

    expect(stacked).not.toBeNull();
    // Stacked, not side by side: the detail starts below the rail.
    expect(stacked?.detailTop ?? 0).toBeGreaterThanOrEqual((stacked?.railBottom ?? 0) - 1);
  });
});
