import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DATASET_ID } from '@datera/core';
import { serveHttp, type RunningServer } from '@datera/cli';
import {
  fixturePaths, openTestWorkspace, testPorts,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * Phase 8, this repo's half only (spec §11.8, §12.10).
 *
 * The Datera Server itself — auth, per-token scoping, deploy orchestration, licensing —
 * lives in the private repo and is not built here. What is built here is the **client's**
 * ability to drive one: environments, a remote client over the public API, and push.
 *
 * §12.10 has two limbs and both are asserted: the client runs fully standalone with no
 * server, *and* the same interface drives a connected one.
 */
describe('§12.10 environments', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('starts with a local environment and nothing else', async () => {
    const environments = await ws.datera.listEnvironments();

    expect(environments).toHaveLength(1);
    expect(environments[0]?.kind).toBe('local');
    expect(environments[0]?.id).toBe('local');
  });

  it('the local environment cannot be removed — there is always somewhere to work', async () => {
    await expect(ws.datera.removeEnvironment('local')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('adds a remote environment', async () => {
    await ws.datera.addEnvironment({
      id: 'test', name: 'Test', url: 'https://datera-test.example', token: 'dtra_secret_value',
    });

    const environments = await ws.datera.listEnvironments();
    expect(environments.map((e) => e.id)).toEqual(['local', 'test']);
    expect(environments.find((e) => e.id === 'test')?.kind).toBe('remote');
  });

  it('keeps the environment token in the keychain, never in the catalog', async () => {
    const ports = testPorts({ http: true });
    const scoped = await openTestWorkspace({ ports });
    try {
      await scoped.datera.addEnvironment({
        id: 'test', name: 'Test', url: 'https://datera-test.example', token: 'dtra_secret_value',
      });

      expect([...ports.secrets.snapshot().values()]).toContain('dtra_secret_value');

      // Not in the listing the UI receives...
      expect(JSON.stringify(await scoped.datera.listEnvironments())).not.toContain('dtra_secret_value');

      // ...nor anywhere in the workspace directory, nor in the log.
      for (const entry of await readdir(scoped.workspacePath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const contents = await readFile(join(scoped.workspacePath, entry.name));
        expect(contents.includes('dtra_secret_value'), `token found in ${entry.name}`).toBe(false);
      }
      expect(ports.logger.serialise()).not.toContain('dtra_secret_value');
    } finally {
      await scoped.dispose();
    }
  });

  it('survives a restart', async () => {
    await ws.datera.addEnvironment({ id: 'prod', name: 'Production', url: 'https://x.example' });
    ws = await ws.reopen();
    expect((await ws.datera.listEnvironments()).map((e) => e.id)).toContain('prod');
  });
});

describe('§12.10 the same interface drives a remote server', () => {
  let local: TestWorkspace;
  let remote: TestWorkspace;
  let server: RunningServer | null = null;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);

    // A genuinely separate workspace, served over HTTP — standing in for a deployed
    // Datera Server. The private repo adds auth and scoping on top of exactly this API.
    remote = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await remote.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    server = await serveHttp({
      datera: remote.datera,
      info: { name: 'datera', version: '0.1.0' },
      port: 0,
      token: 'remote-token',
      log: () => {},
    });

    local = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await local.datera.addEnvironment({
      id: 'test', name: 'Test', url: server.url, token: 'remote-token',
    });
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await local.dispose();
    await remote.dispose();
  });

  it('lists the remote datasets through the same shape as local', async () => {
    const client = await local.datera.connectTo('test');

    const datasets = await client.listDatasets();
    expect(datasets.map((d) => d.id)).toContain(DEFAULT_DATASET_ID);
  });

  it('queries the remote dataset', async () => {
    const client = await local.datera.connectTo('test');

    const result = await client.query(DEFAULT_DATASET_ID, 'SELECT count(*) AS n FROM orders');
    expect(Number(result.rows[0]?.[0])).toBe(6);
  });

  it('lists the remote sources', async () => {
    const client = await local.datera.connectTo('test');

    const sources = await client.listSources();
    expect(sources.map((s) => s.name)).toContain('orders');
  });

  it('carries the read-only guarantee across the wire', async () => {
    const client = await local.datera.connectTo('test');

    await expect(client.query(DEFAULT_DATASET_ID, 'DELETE FROM orders')).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION',
    });
  });

  it('fails clearly with a bad token rather than hanging', async () => {
    await local.datera.addEnvironment({
      id: 'bad', name: 'Bad', url: server!.url, token: 'wrong-token',
    });
    const client = await local.datera.connectTo('bad');

    await expect(client.listDatasets()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });

  it('reports an unreachable environment as unreachable', async () => {
    await local.datera.addEnvironment({ id: 'down', name: 'Down', url: 'http://127.0.0.1:59994' });
    const client = await local.datera.connectTo('down');

    await expect(client.listDatasets()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });

  it('checks reachability without throwing, for the environment list', async () => {
    const statuses = await local.datera.environmentStatuses();

    expect(statuses.find((s) => s.id === 'local')?.reachable).toBe(true);
    expect(statuses.find((s) => s.id === 'test')?.reachable).toBe(true);
  });

  it('still works with no server at all — the standalone limb of §12.10', async () => {
    await server!.close();
    server = null;

    // Everything local keeps working; only the remote environment is unreachable.
    await local.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    const result = await local.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders');
    expect(Number(result.rows[0]?.[0])).toBe(6);

    const statuses = await local.datera.environmentStatuses();
    expect(statuses.find((s) => s.id === 'test')?.reachable).toBe(false);
  });
});

describe('§10 push a dataset to an environment', () => {
  let local: TestWorkspace;
  let remote: TestWorkspace;
  let server: RunningServer | null = null;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);

    remote = await openTestWorkspace({ ports: testPorts({ http: true }) });
    server = await serveHttp({
      datera: remote.datera,
      info: { name: 'datera', version: '0.1.0' },
      port: 0,
      token: 'remote-token',
      allowPush: true,
      log: () => {},
    });

    local = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await local.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await local.datera.addEnvironment({
      id: 'test', name: 'Test', url: server.url, token: 'remote-token',
    });
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await local.dispose();
    await remote.dispose();
  });

  it('pushes a dataset, and it arrives with its data and dictionary', async () => {
    const sourceId = (await local.datera.listSources())[0]!.id;
    const draft = await local.datera.draftDictionary(sourceId);
    await local.datera.confirmColumn(sourceId, {
      ...draft.columns.find((c) => c.column === 'revenue_cents')!,
      state: 'confirmed',
    });

    const result = await local.datera.pushDataset(DEFAULT_DATASET_ID, 'test');
    expect(result.ok).toBe(true);

    // On the remote side, as a real dataset.
    const datasets = await remote.datera.listDatasets();
    const pushed = datasets.find((d) => d.kind === 'imported');
    expect(pushed).toBeDefined();

    const rows = await remote.datera.query(pushed!.id, 'SELECT count(*) FROM orders');
    expect(Number(rows.rows[0]?.[0])).toBe(6);

    // The semantic layer travelled too — push reuses the §12.11 export, so a push cannot
    // be lossy in a way an export is not.
    const remoteSource = (await remote.datera.listSources()).find((s) => s.name === 'orders');
    const dictionary = await remote.datera.getDictionary(remoteSource!.id);
    expect(dictionary.columns.find((c) => c.column === 'revenue_cents')?.state).toBe('confirmed');
  });

  it('refuses to push to the local environment', async () => {
    await expect(local.datera.pushDataset(DEFAULT_DATASET_ID, 'local')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('is refused when the server does not accept pushes', async () => {
    await server!.close();
    server = await serveHttp({
      datera: remote.datera,
      info: { name: 'datera', version: '0.1.0' },
      port: 0,
      token: 'remote-token',
      log: () => {},
    });
    await local.datera.addEnvironment({
      id: 'readonly', name: 'Read only', url: server.url, token: 'remote-token',
    });

    await expect(local.datera.pushDataset(DEFAULT_DATASET_ID, 'readonly')).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
  });
});
