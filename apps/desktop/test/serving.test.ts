import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeApp } from './close-app.js';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { fixturePaths, type FixturePaths } from '@datera/testkit';

/**
 * An agent reaches the workspace the user is looking at (§8).
 *
 * DuckDB allows one writer. `datera --mcp --workspace <the app's workspace>` therefore
 * failed on the lock for as long as the app was open, which meant the stdio config
 * Settings → Serving generated could not be used without quitting Datera — a choice
 * between an agent and the app rather than a way to have both. Verified from the outside,
 * over a real socket, because that is the part that was broken.
 */
const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('serving an agent while the app is open', () => {
  let app: ElectronApplication;
  let page: Page;
  let workspacePath: string;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    workspacePath = await mkdtemp(join(tmpdir(), 'datera-serving-'));

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

  it('is off until asked, so installing the app opens no port', async () => {
    const status = await page.evaluate(async () =>
      (globalThis as unknown as { datera: { servingStatus(): Promise<{ running: boolean }> } })
        .datera.servingStatus(),
    );
    expect(status.running).toBe(false);
  });

  it('answers a real agent over the socket, on the workspace the app is holding', async () => {
    // Port 0, so the run cannot collide with a real Datera serving on the default port
    // on the same machine. That the default is 8899 is the core's business and is tested
    // there; what matters here is that the socket answers.
    const started = await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { startServing(port: number): Promise<{ running: boolean; url?: string; token?: string }> };
      }).datera.startServing(0),
    );

    expect(started.running).toBe(true);
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started.token).toBeDefined();

    // From outside the app entirely — a plain HTTP client, exactly as an agent would,
    // carrying the session the handshake hands back so later calls keep its name.
    let session: string | null = null;
    const call = async (body: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(`${started.url!}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${started.token!}`,
          ...(session === null ? {} : { 'mcp-session-id': session }),
        },
        body: JSON.stringify(body),
      });
      session = response.headers.get('mcp-session-id') ?? session;
      return (await response.json()) as Record<string, unknown>;
    };

    const initialized = await call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Claude Code' } },
    });
    expect(initialized['result']).toBeDefined();
    expect(session).not.toBeNull();

    const called = await call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'query_ungrouped', arguments: { sql: 'SELECT count(*) AS n FROM orders' } },
    });
    const result = called['result'] as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).not.toBe(true);
    // A BIGINT crosses JSON as a string rather than silently losing precision above 2^53.
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ rows: [['6']] });
  });

  it('refuses a caller without the token, because loopback is not a permission', async () => {
    const status = await page.evaluate(async () =>
      (globalThis as unknown as { datera: { servingStatus(): Promise<{ url?: string }> } })
        .datera.servingStatus(),
    );

    const response = await fetch(`${status.url!}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('shows that served request in Activity, on the same trace the UI reads', async () => {
    // The point of the app hosting the server: the agent's traffic lands in the log the
    // user is already looking at, rather than in a separate process's.
    const records = await page.evaluate(async () =>
      (globalThis as unknown as {
        datera: { queryTraceLog(q: unknown): Promise<{ origin: string; stages: { kind: string; label: string }[] }[]> };
      }).datera.queryTraceLog({ limit: 20 }),
    );

    const served = records.find((r) => r.origin === 'tool');
    expect(served).toBeDefined();
    expect(served!.stages[0]?.kind).toBe('agent');
    expect(served!.stages[0]?.label).toBe('Claude Code');
    expect(served!.stages[1]?.label).toBe('HTTP');
  });

  it('stops when told to, and the port is genuinely closed', async () => {
    const before = await page.evaluate(async () =>
      (globalThis as unknown as { datera: { servingStatus(): Promise<{ url?: string }> } })
        .datera.servingStatus(),
    );

    const stopped = await page.evaluate(async () =>
      (globalThis as unknown as { datera: { stopServing(): Promise<{ running: boolean }> } })
        .datera.stopServing(),
    );
    expect(stopped.running).toBe(false);

    await expect(fetch(`${before.url!}/healthz`)).rejects.toThrow();
  });
});
