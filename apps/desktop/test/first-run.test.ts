import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * The first launch, with nothing configured.
 *
 * Weights are fetched rather than shipped, so a fresh install has no model. An empty
 * state that does not explain itself is indistinguishable from a broken install — and
 * "the headline feature does nothing and I do not know why" is the worst first minute a
 * local-first tool can offer.
 *
 * No download happens here: the assertions are about what is offered and how honestly,
 * which is the part that can regress silently.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('first run', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-firstrun-'));
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

  it('offers a local model, rather than leaving Ask quietly broken', async () => {
    await page.waitForSelector('[data-firstrun]', { timeout: 30_000 });
    const text = await page.textContent('[data-firstrun]');

    expect(text).toMatch(/on this machine/i);
    expect(text).toMatch(/no key/i);
  });

  it('states the download size before asking for it', async () => {
    // A one-time two-gigabyte download is a real cost. Burying it behind "Get started"
    // would be the kind of thing this product exists not to do.
    const button = await page.textContent('[data-firstrun-download]');
    expect(button).toMatch(/\d+(\.\d+)?\s*GB/i);
  });

  it('recommends a size rather than the same one for every machine', async () => {
    const recommended = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        datera: { listModels(): Promise<{ bundled: { modelId: string; recommended: boolean }[] }> };
      }).datera;
      return (await api.listModels()).bundled.filter((m) => m.recommended).map((m) => m.modelId);
    });

    expect(recommended).toHaveLength(1);
  });

  it('says what still works without it, so declining is an informed choice', async () => {
    expect(await page.textContent('[data-firstrun]')).toMatch(/SQL|schema|completions/i);
  });

  it('can be dismissed, and stays dismissed while you work', async () => {
    await page.click('[data-firstrun-dismiss]');
    await expect.poll(async () => page.locator('[data-firstrun]').count()).toBe(0);

    // Navigating away and back must not bring it back like an upsell.
    await page.click('[data-nav="query"]');
    await page.click('[data-nav="data"]');
    expect(await page.locator('[data-firstrun]').count()).toBe(0);
  });

  it('never appears once any chat model is configured', async () => {
    // This is what makes it an offer rather than an advertisement: it is tied to the
    // workspace genuinely having nothing to answer with, not to a dismissal flag. It does
    // return after a restart if you still have no model — because Ask still cannot work.
    await page.evaluate(async () => {
      await (globalThis as unknown as {
        datera: { setChatModel(m: unknown): Promise<void> };
      }).datera.setChatModel({
        tier: 'remote', provider: 'anthropic', id: 'claude-sonnet-5',
        role: 'chat', locality: 'remote', label: 'Claude',
      });
    });

    await page.reload();
    await page.waitForSelector('.brand', { timeout: 30_000 });
    await page.waitForTimeout(500);

    expect(await page.locator('[data-firstrun]').count()).toBe(0);
  });
});
