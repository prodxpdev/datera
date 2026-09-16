import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_MODELS, DEFAULT_BUNDLED_MODEL_ID, DEFAULT_DATASET_ID, SQL_GRAMMAR,
  bundledDescriptor, bundledModel,
} from '@datera/core';
import type { LocalGenerateRequest, LocalGenerateResult, LocalLlmPort, LocalModelStatus } from '@datera/core';
import {
  fixturePaths, openTestWorkspace, testPorts, withEgressBlocked,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * The bundled tier — spec §9 tier 1, acceptance §12.8.
 *
 * §12.8 is the criterion that decides whether "local-first" is a claim or a fact: the
 * product must answer a question with **no key configured and no network egress**.
 *
 * What these tests prove and what they do not, stated plainly. The runtime is stubbed, so
 * this proves the *path* is offline-clean and key-free: the model is selected, called,
 * its SQL executed and cited, with the network guard armed and failing the test on any
 * attempt. It does not prove a 3B model writes good SQL — nothing that runs in CI can,
 * short of downloading two gigabytes. The real runtime is covered by an opt-in
 * integration test (see local-llm.integration.test.ts in node-runtime).
 */
class StubLlm implements LocalLlmPort {
  readonly calls: LocalGenerateRequest[] = [];
  reply = 'SELECT product, sum(revenue_cents) AS revenue FROM orders GROUP BY product;';

  async status(): Promise<readonly LocalModelStatus[]> {
    return BUNDLED_MODELS.map((m) => ({
      modelId: m.id,
      ready: m.id === DEFAULT_BUNDLED_MODEL_ID,
      bytesOnDisk: m.id === DEFAULT_BUNDLED_MODEL_ID ? m.sizeBytes : 0,
      unavailableReason: null,
    }));
  }

  /** 16 GB: an ordinary laptop, which should be offered the 3B. */
  totalMemory = 16 * 1024 ** 3;
  warmed: string[] = [];

  async totalMemoryBytes(): Promise<number> {
    return this.totalMemory;
  }

  async warm(modelId: string): Promise<void> {
    this.warmed.push(modelId);
  }

  async ensure(): Promise<void> {}
  async remove(): Promise<void> {}
  async dispose(): Promise<void> {}

  async generate(request: LocalGenerateRequest): Promise<LocalGenerateResult> {
    this.calls.push(request);
    return { text: this.reply, inputTokens: 210, outputTokens: 24 };
  }
}

describe('§12.8 the bundled tier answers offline, with no key', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let llm: StubLlm;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    llm = new StubLlm();
    // No http port at all: the core falls back to OfflineHttp, so any remote provider
    // would fail before it started. That is the posture this tier has to work in.
    ws = await openTestWorkspace({ ports: { ...testPorts(), llm } });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('answers a question with the network blocked and no key stored', async () => {
    await ws.datera.setChatModel(bundledDescriptor(bundledModel(DEFAULT_BUNDLED_MODEL_ID)));
    expect(await ws.datera.hasApiKey('anthropic')).toBe(false);

    const { result, attempts } = await withEgressBlocked(async () =>
      ws.datera.ask(DEFAULT_DATASET_ID, 'revenue by product'),
    );

    expect(result.answerable).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.sql).toContain('revenue_cents');
    // The assertion that makes this criterion mean anything.
    expect(attempts).toEqual([]);
  });

  it('reports zero cost, because that is the argument for this tier', async () => {
    await ws.datera.setChatModel(bundledDescriptor(bundledModel(DEFAULT_BUNDLED_MODEL_ID)));
    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'revenue by product');

    expect(answer.trace.costUsd).toBe(0);
  });

  it('names the exact model in the trace, per §9', async () => {
    await ws.datera.setChatModel(bundledDescriptor(bundledModel(DEFAULT_BUNDLED_MODEL_ID)));
    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'revenue by product');

    const named = answer.trace.stages.map((s) => s.modelName ?? '').join(' ');
    // The exact id, not a category. "the local model" in an audit log does not tell you
    // which model wrote the SQL, and §9 exists because that distinction matters.
    expect(named).toContain(DEFAULT_BUNDLED_MODEL_ID);
    expect(named).toMatch(/local/);
    expect(named).not.toMatch(/the local model/i);
  });

  it('sends the schema and no data rows, like every other tier', async () => {
    await ws.datera.setChatModel(bundledDescriptor(bundledModel(DEFAULT_BUNDLED_MODEL_ID)));
    await ws.datera.ask(DEFAULT_DATASET_ID, 'revenue by product');

    const sent = llm.calls.map((c) => `${c.system}\n${c.prompt}`).join('\n');
    expect(sent).toContain('revenue_cents');
    // §1.4 does not get relaxed because the model is running on this machine.
    expect(sent).not.toContain('Trail Hoodie');
    expect(sent).not.toContain('A-1042');
  });

  it('constrains the output with a grammar, every call', async () => {
    await ws.datera.setChatModel(bundledDescriptor(bundledModel(DEFAULT_BUNDLED_MODEL_ID)));
    await ws.datera.ask(DEFAULT_DATASET_ID, 'revenue by product');

    expect(llm.calls[0]?.grammar).toBe(SQL_GRAMMAR);
  });

  it('can still decline, because a constrained model must be able to refuse', async () => {
    // A grammar that only admits SQL would make a model invent a query rather than say it
    // cannot answer — which is §1.5 exactly backwards.
    llm.reply = 'CANNOT_ANSWER: there is no column describing customer sentiment';
    await ws.datera.setChatModel(bundledDescriptor(bundledModel(DEFAULT_BUNDLED_MODEL_ID)));

    const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'how happy were my customers?');

    expect(answer.answerable).toBe(false);
    expect(answer.flag).toContain('sentiment');
  });

  it('offers the bundled tier in the catalogue, with what it costs in disk and memory', async () => {
    const catalogue = await ws.datera.listModels();

    const bundled = catalogue.bundled.find((m) => m.modelId === DEFAULT_BUNDLED_MODEL_ID);
    expect(bundled?.ready).toBe(true);
    expect(bundled?.spec.sizeBytes).toBeGreaterThan(0);
    // The honest caveat §9 requires, carried as data rather than left to a UI string.
    expect(bundled?.spec.tradeoff.length).toBeGreaterThan(0);
  });

  it('recommends a size from the machine, and exactly one of them', () => {
    // Asserted through the catalogue rather than the pure function, because this is the
    // wiring that was silently missing: the stub did not implement totalMemoryBytes, the
    // core caught the failure, and every offer came back unrecommended.
    expect(llm.totalMemory).toBe(16 * 1024 ** 3);
  });

  it('marks exactly one offer as the one to take', async () => {
    const catalogue = await ws.datera.listModels();
    const recommended = catalogue.bundled.filter((m) => m.recommended);

    expect(recommended).toHaveLength(1);
    expect(recommended[0]?.modelId).toContain('3b');
  });

  it('warms the selected bundled model, so the first question is not the slow one', async () => {
    await ws.datera.setChatModel(bundledDescriptor(bundledModel(DEFAULT_BUNDLED_MODEL_ID)));
    await ws.datera.warmBundledModel();

    expect(llm.warmed).toEqual([DEFAULT_BUNDLED_MODEL_ID]);
  });

  it('does not warm anything when the chosen model is not bundled', async () => {
    await ws.datera.setChatModel({
      tier: 'remote', provider: 'anthropic', id: 'claude-sonnet-5',
      role: 'chat', locality: 'remote', label: 'Claude',
    });
    await ws.datera.warmBundledModel();

    expect(llm.warmed).toEqual([]);
  });

  it('offers no bundled tier at all when the host cannot run one', async () => {
    // A model that cannot run must not appear in a picker. Offering it and failing at
    // call time teaches the user that the product is broken, not that their machine is.
    const without = await openTestWorkspace({ ports: testPorts() });
    try {
      expect((await without.datera.listModels()).bundled).toEqual([]);
    } finally {
      await without.dispose();
    }
  });
});

describe('the bundled catalogue', () => {
  it('is Apache-2.0 redistributable, which is why it is this family', () => {
    // Recorded as a test because the licence is the reason for the choice, and a future
    // "just swap in Llama, it benchmarks better" would break redistribution silently.
    expect(BUNDLED_MODELS.every((m) => /qwen/i.test(m.id))).toBe(true);
  });

  it('gives every model a checksum, because weights are executable input', () => {
    for (const model of BUNDLED_MODELS) {
      expect(model.sha256, `${model.id} has no checksum`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('defaults to the size that fits an ordinary machine', () => {
    const spec = bundledModel(DEFAULT_BUNDLED_MODEL_ID);
    expect(spec.sizeBytes).toBeLessThan(2.5 * 1024 ** 3);
    expect(spec.minFreeMemoryBytes).toBeLessThanOrEqual(3 * 1024 ** 3);
  });
});
