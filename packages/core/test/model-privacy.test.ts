import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DATASET_ID, apiKeySecretName } from '@datera/core';
import {
  fixturePaths,
  openTestWorkspace,
  startStubModelServer,
  testPorts,
  withEgressBlocked,
  type FixturePaths,
  type StubModelServer,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * The privacy half of spec §9 and acceptance §12.8.
 *
 * Each of these asserts an absence — no network, no key on disk, no key in a log. Absences
 * are the assertions most easily believed without being checked, and the ones most
 * expensive to get wrong.
 */
describe('model privacy and offline behaviour', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
  });

  afterEach(async () => {
    await ws?.dispose();
  });

  describe('§12.8 — no key configured means no network', () => {
    it('opens, connects and queries with egress blocked and no model set', async () => {
      const { attempts } = await withEgressBlocked(async () => {
        ws = await openTestWorkspace({ ports: testPorts() });
        await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
        const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders');
        expect(Number(result.rows[0]?.[0])).toBe(6);
      });

      expect(attempts, `unexpected egress: ${attempts.map((a) => a.target).join(', ')}`).toEqual([]);
    });

    it('cannot reach the network at all when the host supplies no HTTP port', async () => {
      // The default posture. A host must hand the core an HttpPort for it to have one,
      // so "local-only" is a property of the wiring rather than of everyone remembering.
      ws = await openTestWorkspace({ ports: testPorts() });

      const catalogue = await ws.datera.listModels();
      expect(catalogue.detected).toEqual([]);
      expect(catalogue.selected).toBeNull();
    });

    it('reports no detected runtimes rather than failing, when none are running', async () => {
      ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
      const catalogue = await ws.datera.listModels();
      // Nothing is listening on the default Ollama/LM Studio ports in CI.
      expect(Array.isArray(catalogue.detected)).toBe(true);
    });
  });

  describe('API keys', () => {
    const KEY = 'sk-ant-test-key-do-not-leak-0123456789';

    it('stores a key in the secret store and nowhere else', async () => {
      const ports = testPorts({ http: true });
      ws = await openTestWorkspace({ ports });

      await ws.datera.setApiKey('anthropic', KEY);

      expect([...ports.secrets.snapshot().values()]).toContain(KEY);
      expect(ports.secrets.snapshot().has(apiKeySecretName('anthropic'))).toBe(true);

      // Not in any file in the workspace directory...
      for (const entry of await readdir(ws.workspacePath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const contents = await readFile(join(ws.workspacePath, entry.name));
        expect(contents.includes(KEY), `key found in ${entry.name}`).toBe(false);
      }

      // ...and not in the log.
      expect(ports.logger.serialise()).not.toContain(KEY);
    });

    it('refuses to store a key when there is no protected storage', async () => {
      const ports = testPorts({ http: true });
      ports.secrets.setAvailable(false);
      ws = await openTestWorkspace({ ports });

      await expect(ws.datera.setApiKey('anthropic', KEY)).rejects.toMatchObject({
        code: 'SECRET_STORE_UNAVAILABLE',
      });
      expect(ports.secrets.snapshot().size).toBe(0);
    });

    it('never puts a key in the model catalogue the UI receives', async () => {
      const ports = testPorts({ http: true });
      ws = await openTestWorkspace({ ports });
      await ws.datera.setApiKey('anthropic', KEY);

      const catalogue = await ws.datera.listModels();
      expect(JSON.stringify(catalogue)).not.toContain(KEY);
      // But the models it unlocks are offered.
      expect(catalogue.remote.map((m) => m.id)).toContain('claude-sonnet-4-5');
    });

    it('never puts a key in the trace', async () => {
      const server: StubModelServer = await startStubModelServer();
      try {
        const ports = testPorts({ http: true });
        ws = await openTestWorkspace({ ports });
        await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
        await ws.datera.setApiKey('openai', 'sk-openai-secret-value-123456');
        await ws.datera.setChatModel({
          tier: 'remote', provider: 'openai', id: 'gpt-4o-mini', role: 'chat',
          locality: 'remote', endpoint: server.url, label: 'gpt-4o-mini',
        });

        server.setReply('SELECT count(*) FROM orders');
        const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'count');

        // The trace is shown in the UI and will be persisted as the audit log (§8a).
        expect(JSON.stringify(answer.trace)).not.toContain('sk-openai-secret-value-123456');
        // And it still names the model exactly, as §9 requires.
        expect(answer.trace.stages.find((s) => s.kind === 'model')?.modelName).toContain('gpt-4o-mini');
      } finally {
        await server.close();
      }
    });

    it('forgets a key on request', async () => {
      const ports = testPorts({ http: true });
      ws = await openTestWorkspace({ ports });

      await ws.datera.setApiKey('anthropic', KEY);
      expect(await ws.datera.hasApiKey('anthropic')).toBe(true);

      await ws.datera.clearApiKey('anthropic');
      expect(await ws.datera.hasApiKey('anthropic')).toBe(false);
      expect([...ports.secrets.snapshot().values()]).not.toContain(KEY);
    });
  });

  describe('model selection persists', () => {
    it('survives a restart, and is still named exactly', async () => {
      ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
      await ws.datera.setChatModel({
        tier: 'detected', provider: 'ollama', id: 'qwen2.5-coder:7b', role: 'chat',
        locality: 'local', endpoint: 'http://127.0.0.1:11434', label: 'qwen2.5-coder:7b',
      });

      ws = await ws.reopen();

      const catalogue = await ws.datera.listModels();
      expect(catalogue.selected?.id).toBe('qwen2.5-coder:7b');
      expect(catalogue.selectedName).toBe('Ollama · qwen2.5-coder:7b (local · 127.0.0.1:11434)');
    });
  });
});
