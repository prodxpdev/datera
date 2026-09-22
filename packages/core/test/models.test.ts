import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AnthropicChatModel,
  OpenAICompatibleChatModel,
  computeCost,
  describeModel,
  detectLocalRuntimes,
  estimateTokens,
} from '@datera/core';
import { NodeHttp } from '@datera/node-runtime';
import { startStubModelServer, type StubModelServer } from '@datera/testkit';

/**
 * Spec §9 — the three provider tiers.
 *
 * Driven against a stub server rather than real providers, because a test that only runs
 * when somebody happens to have Ollama installed is a test that does not run. The stub
 * also captures exactly what was sent, which is the only way to assert the thing that
 * actually matters: what Datera does *not* put in a model payload.
 */
describe('§9 model providers', () => {
  let server: StubModelServer;
  const http = new NodeHttp();

  beforeEach(async () => {
    server = await startStubModelServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('OpenAI-compatible (Ollama, LM Studio, custom endpoints, OpenAI)', () => {
    it('calls /v1/chat/completions and returns the text', async () => {
      server.setReply('SELECT product, sum(revenue_cents) FROM orders GROUP BY product');

      const model = new OpenAICompatibleChatModel({
        http,
        baseUrl: server.url,
        modelId: 'llama3.1:8b',
        descriptor: {
          tier: 'detected',
          provider: 'ollama',
          id: 'llama3.1:8b',
          role: 'chat',
          locality: 'local',
          endpoint: server.url,
          label: 'llama3.1:8b',
        },
      });

      const response = await model.chat({ messages: [{ role: 'user', content: 'top products' }] });

      expect(response.text).toContain('SELECT product');
      expect(server.requests.at(-1)?.path).toBe('/v1/chat/completions');
      expect(server.requests.at(-1)?.method).toBe('POST');
    });

    it('reports the provider’s own token counts, not an estimate', async () => {
      const model = makeOllama(server.url);
      const response = await model.chat({ messages: [{ role: 'user', content: 'hi' }] });

      // The stub reports 123/45. Anything else means we substituted a guess for a fact,
      // which in the cost line is exactly where the product must not do that.
      expect(response.usage.inputTokens).toBe(123);
      expect(response.usage.outputTokens).toBe(45);
    });

    it('costs nothing on a local tier, and says so', async () => {
      const model = makeOllama(server.url);
      const response = await model.chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(response.usage.costUsd).toBe(0);
      expect(response.model.locality).toBe('local');
    });

    it('sends no Authorization header when there is no key', async () => {
      const model = makeOllama(server.url);
      await model.chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(server.requests.at(-1)?.headers['authorization']).toBeUndefined();
    });

    it('sends the key when given one, and never puts it in the descriptor', async () => {
      const model = new OpenAICompatibleChatModel({
        http,
        baseUrl: server.url,
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-test-secret-value',
        descriptor: {
          tier: 'remote',
          provider: 'openai',
          id: 'gpt-4o-mini',
          role: 'chat',
          locality: 'remote',
          label: 'gpt-4o-mini',
        },
      });

      await model.chat({ messages: [{ role: 'user', content: 'hi' }] });

      expect(server.requests.at(-1)?.headers['authorization']).toBe('Bearer sk-test-secret-value');
      // The descriptor travels into traces and the UI. A key must never ride along.
      expect(JSON.stringify(model.descriptor)).not.toContain('sk-test-secret-value');
    });

    it('surfaces a provider failure as a typed error without leaking the key', async () => {
      server.setFailure(401, '{"error":{"message":"bad key sk-test-secret-value"}}');

      const model = new OpenAICompatibleChatModel({
        http,
        baseUrl: server.url,
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-test-secret-value',
        descriptor: {
          tier: 'remote', provider: 'openai', id: 'gpt-4o-mini', role: 'chat',
          locality: 'remote', label: 'gpt-4o-mini',
        },
      });

      const error = await model.chat({ messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe('MODEL_CALL_FAILED');
      expect(String((error as Error).message)).not.toContain('sk-test-secret-value');
    });
  });

  describe('Anthropic', () => {
    it('calls /v1/messages with the version header and reports usage', async () => {
      server.setReply('SELECT 1');
      const model = new AnthropicChatModel({
        http,
        baseUrl: server.url,
        modelId: 'claude-sonnet-4-5',
        apiKey: 'sk-ant-secret',
      });

      const response = await model.chat({
        messages: [
          { role: 'system', content: 'You write SQL.' },
          { role: 'user', content: 'count the orders' },
        ],
      });

      const sent = server.requests.at(-1);
      expect(sent?.path).toBe('/v1/messages');
      expect(sent?.headers['anthropic-version']).toBeDefined();
      expect(sent?.headers['x-api-key']).toBe('sk-ant-secret');

      // Anthropic takes the system prompt as a top-level field, not as a message.
      const body = sent?.json as { system?: string; messages?: { role: string }[] };
      expect(body.system).toBe('You write SQL.');
      expect(body.messages?.every((m) => m.role !== 'system')).toBe(true);

      expect(response.text).toBe('SELECT 1');
      expect(response.usage.inputTokens).toBe(123);
      expect(response.usage.costUsd).toBeGreaterThan(0);
    });
  });

  describe('detection of local runtimes', () => {
    it('finds a running OpenAI-compatible runtime and lists its models', async () => {
      server.setModels(['llama3.1:8b', 'qwen2.5-coder:7b']);

      const found = await detectLocalRuntimes({
        http,
        candidates: [{ provider: 'ollama', baseUrl: server.url }],
        timeoutMs: 2_000,
      });

      expect(found).toHaveLength(1);
      expect(found[0]?.provider).toBe('ollama');
      expect(found[0]?.models.map((m) => m.id)).toEqual(['llama3.1:8b', 'qwen2.5-coder:7b']);
      expect(found[0]?.models.every((m) => m.tier === 'detected' && m.locality === 'local')).toBe(true);
    });

    it('reports nothing, and does not throw, when no runtime is listening', async () => {
      // Spec §9: detection is best-effort and non-blocking; never list a runtime that is
      // not running, and never hard-fail because one is absent.
      const found = await detectLocalRuntimes({
        http,
        candidates: [{ provider: 'ollama', baseUrl: 'http://127.0.0.1:59997' }],
        timeoutMs: 1_000,
      });

      expect(found).toEqual([]);
    });

    it('gives up quickly rather than hanging the UI', async () => {
      server.setLatency(3_000);

      const started = Date.now();
      const found = await detectLocalRuntimes({
        http,
        candidates: [{ provider: 'ollama', baseUrl: server.url }],
        timeoutMs: 300,
      });
      const elapsed = Date.now() - started;

      expect(found).toEqual([]);
      // Generous, but nowhere near the 3s the server would have taken.
      expect(elapsed).toBeLessThan(2_000);
    });

    it('probes candidates concurrently, so several dead ports cost one timeout', async () => {
      const started = Date.now();
      await detectLocalRuntimes({
        http,
        candidates: [
          { provider: 'ollama', baseUrl: 'http://127.0.0.1:59997' },
          { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:59996' },
          { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:59995' },
        ],
        timeoutMs: 800,
      });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('survives a runtime that answers with nonsense', async () => {
      server.setFailure(200, 'this is not json');
      const found = await detectLocalRuntimes({
        http,
        candidates: [{ provider: 'ollama', baseUrl: server.url }],
        timeoutMs: 1_000,
      });
      expect(found).toEqual([]);
    });
  });

  describe('naming a model exactly (spec §9)', () => {
    it('renders tier, provider, id and locality', () => {
      expect(
        describeModel({
          tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
          locality: 'local', endpoint: 'http://localhost:11434', label: 'llama3.1:8b',
        }),
      ).toBe('Ollama · llama3.1:8b (local · localhost:11434)');

      expect(
        describeModel({
          tier: 'remote', provider: 'anthropic', id: 'claude-sonnet-4-5', role: 'chat',
          locality: 'remote', label: 'claude',
        }),
      ).toBe('Anthropic · claude-sonnet-4-5 (remote)');
    });

    it('never renders a vague name', () => {
      const rendered = describeModel({
        tier: 'bundled', provider: 'bundled', id: 'qwen2.5-coder-1.5b-instruct-q4', role: 'chat',
        locality: 'local', label: 'Bundled',
      });
      expect(rendered).not.toBe('the local model');
      expect(rendered).toContain('qwen2.5-coder-1.5b-instruct-q4');
    });
  });

  describe('cost arithmetic', () => {
    it('computes from the provider’s counts', () => {
      const cost = computeCost(
        { inputTokens: 1_000_000, outputTokens: 500_000 },
        { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
      );
      expect(cost).toBeCloseTo(3 + 7.5, 6);
    });

    it('is zero for a free tier', () => {
      expect(computeCost({ inputTokens: 9_999, outputTokens: 9_999 }, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 })).toBe(0);
    });

    it('estimates tokens only as a fallback', () => {
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('')).toBe(1);
    });
  });

  function makeOllama(baseUrl: string): OpenAICompatibleChatModel {
    return new OpenAICompatibleChatModel({
      http,
      baseUrl,
      modelId: 'llama3.1:8b',
      descriptor: {
        tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
        locality: 'local', endpoint: baseUrl, label: 'llama3.1:8b',
      },
    });
  }
});
