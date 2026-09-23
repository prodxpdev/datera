#!/usr/bin/env node
/**
 * Photograph the real application.
 *
 * The screenshots in docs/ are from the prototype: their navigation reads "Workspace / Ask
 * / SQL / Serve", which the shipped app has not had for some time. Putting those on a
 * marketing site would show people a product that does not exist — a particularly bad
 * failure for this one, whose whole claim is that it does not misrepresent itself.
 *
 * So these are taken from the app as built, against the same fixtures the tests use, and
 * regenerated whenever the UI changes rather than curated by hand.
 *
 * Lives under apps/desktop because that is where Playwright resolves from — the script
 * drives the built app, so it belongs with it.
 *
 * Usage: node apps/desktop/scripts/screenshots.mjs [--out <directory>]
 */
import { _electron as electron } from 'playwright';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const appRoot = join(repo, 'apps', 'desktop');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const out = resolve(flag('out', join(repo, 'screenshots')));
const fixtures = process.env['DATERA_FIXTURES'] ?? join(repo, 'fixtures', 'generated');

// Wide enough that the app is not in its narrow layout, and a 2:1-ish shape that sits well
// in a page without needing to be cropped.
const VIEWPORT = { width: 1440, height: 900 };

await mkdir(out, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), 'datera-shots-'));

// The "how this source was read" panel prints the source path, so the fixtures are copied
// somewhere neutral first. A screenshot carrying /Users/<someone> is a small leak and an
// unnecessarily scruffy thing to publish.
const demo = '/tmp/datera-demo';
await rm(demo, { recursive: true, force: true });
await mkdir(demo, { recursive: true });
await copyFile(join(fixtures, 'orders.csv'), join(demo, 'orders.csv'));
await copyFile(join(fixtures, 'customers.sqlite'), join(demo, 'customers.sqlite'));

const app = await electron.launch({
  args: [appRoot],
  env: {
    ...process.env,
    DATERA_WORKSPACE: workspace,
    DATERA_HEADLESS: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
});

const page = await app.firstWindow();
await page.setViewportSize(VIEWPORT);
await page.waitForSelector('.brand', { timeout: 60_000 });

// Real data, so the screenshots show a working product rather than empty states.
await page.evaluate(async (paths) => {
  const datera = globalThis.datera;
  await datera.addSource({ type: 'file', path: paths.orders, name: 'orders' });
  // A database, not a file — the point of the "spreadsheet or database" story is that
  // both arrive the same way and sit side by side afterwards.
  await datera.addSource({ type: 'sqlite', path: paths.customers });
}, { orders: join(demo, 'orders.csv'), customers: join(demo, 'customers.sqlite') });

await page.reload();
await page.waitForSelector('.srcitem', { timeout: 30_000 });

// The first-run model prompt is correct behaviour and the wrong subject: it covers the top
// third of every view, and these shots are meant to show the product working, not the
// moment before it is set up.
const notNow = page.locator('button', { hasText: /^Not now$/ }).first();
if (await notNow.count()) {
  await notNow.click();
  await page.waitForTimeout(400);
}

const shots = [];

/**
 * Take one screenshot.
 *
 * `focus` is a selector to bring into view first: these views are taller than the window,
 * and the interesting part is rarely the top of the page. Without it every shot is a
 * header and a banner.
 */
async function shot(name, prepare, focus) {
  try {
    await prepare();
    if (focus !== undefined) {
      const target = page.locator(focus).first();
      if (await target.count()) {
        await target.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
      }
    }
    // Let fonts settle and any entry transition finish, or the capture catches a half-drawn
    // frame that looks like a rendering bug in a still image.
    await page.waitForTimeout(700);
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(name);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`Capturing into ${out}`);

await shot(
  'data',
  async () => {
    await page.click('[data-nav="data"]');
    await page.waitForSelector('.srcitem', { timeout: 20_000 });
  },
  '.srcitem',
);

await shot(
  'query-sql',
  async () => {
    await page.click('[data-nav="query"]');
    await page.waitForTimeout(500);

    const editor = page.locator('textarea').first();
    await editor.fill(
      'SELECT product,\n       sum(revenue_cents) / 100.0 AS revenue_usd,\n       count(*) AS orders\nFROM orders\nWHERE NOT refunded\nGROUP BY product\nORDER BY revenue_usd DESC',
    );
    // Completions open while typing and would sit over the result in a still image.
    await editor.press('Escape');
    await page.waitForTimeout(200);

    const run = page.locator('button', { hasText: /^▶?\s*Run$/ }).first();
    if (await run.count()) await run.click();
    // Wait for rows rather than a fixed delay: the screenshot is of a result, so there has
    // to be one.
    await page.waitForSelector('.qresult table tbody tr, .resulttable tbody tr, table tbody tr', {
      timeout: 30_000,
    }).catch(() => undefined);
  },
  'textarea',
);

// Serve one request to an "agent", so the trace shown is the interesting one.
//
// A local SQL query traces as a single guard hop, which is honest and dull. A request that
// arrived from outside carries the whole journey — who called, over what transport, the
// parse, the guard, the engine — and that is the picture the glass box is actually for.
try {
  const serving = await page.evaluate(async () => globalThis.datera.startServing(0));
  if (serving.running === true && serving.url !== undefined) {
    let session = null;
    const call = async (body) => {
      const response = await fetch(`${serving.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${serving.token}`,
          ...(session === null ? {} : { 'mcp-session-id': session }),
        },
        body: JSON.stringify(body),
      });
      session = response.headers.get('mcp-session-id') ?? session;
      return response.json();
    };

    await call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Claude Code' } },
    });
    await call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'query_ungrouped',
        arguments: { sql: 'SELECT product, sum(revenue_cents) / 100.0 AS revenue_usd FROM orders GROUP BY product ORDER BY revenue_usd DESC' },
      },
    });

    await page.evaluate(async () => globalThis.datera.stopServing());
    console.log('  · served one agent request, for the trace');
  }
} catch (e) {
  // No keychain, no token, no served request — the local query's trace is still captured.
  console.log(`  · no served request (${e instanceof Error ? e.message : String(e)})`);
}

await shot(
  'activity',
  async () => {
    await page.click('[data-nav="activity"]');
    await page.waitForSelector('.logtable tbody tr', { timeout: 20_000 }).catch(() => undefined);
  },
  '.logtable',
);

await shot(
  'trace',
  async () => {
    // The glass box, which is the whole pitch.
    //
    // Taken from Activity rather than from an answer, because the drawer on an Ask result
    // needs a model configured and these shots deliberately run without one. The trace is
    // the same trace: the SQL that just ran is in the log like everything else.
    const row = page.locator('.logtable tbody tr').first();
    if (await row.count()) {
      await row.click();
      await page.waitForSelector('[data-traceflow]', { timeout: 20_000 }).catch(() => undefined);
    }
  },
  '[data-traceflow]',
);

await shot(
  'meaning',
  async () => {
    const close = page.locator('[data-close]').first();
    if (await close.count()) await close.click();
    await page.click('[data-nav="meaning"]');
    await page.waitForTimeout(900);
  },
  'table',
);

await shot(
  'learn',
  async () => {
    await page.click('[data-nav="learn"]');
    await page.waitForTimeout(800);
  },
  '.lifecycle, .stage, section',
);

await app.close().catch(() => undefined);
await rm(workspace, { recursive: true, force: true });

console.log(`\n${shots.length} screenshot(s) in ${out}`);
