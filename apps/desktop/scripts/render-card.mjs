#!/usr/bin/env node
/**
 * Render an HTML card to a PNG at an exact size.
 *
 * Used for the marketing site's link-preview image. It lives here because this is where
 * Playwright is installed, and adding a browser dependency to a site that has no build step
 * at all would be a poor trade for one image.
 *
 * Usage: node apps/desktop/scripts/render-card.mjs <card.html> <out.png> [width] [height]
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [input, output, width = '1200', height = '630'] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error('Usage: render-card.mjs <card.html> <out.png> [width] [height]');
  process.exit(1);
}

const browser = await chromium.launch();
// deviceScaleFactor 2: the card is shown at roughly its natural size in a feed, and a 1×
// render of 23px text looks soft next to everything around it.
const page = await browser.newPage({
  viewport: { width: Number(width), height: Number(height) },
  deviceScaleFactor: 2,
});

await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: 'networkidle' });

// Webfonts, specifically: a screenshot taken before they load is the fallback typeface.
//
// Passed as a string rather than a function, because the body runs inside the browser where
// `document` exists — as a function it is lint-checked against this file's Node globals,
// where it does not.
await page.evaluate('document.fonts.ready');
await page.waitForTimeout(400);

await page.screenshot({ path: resolve(output) });
await browser.close();
console.log(`${output} — ${width}×${height} at 2×`);
