import { describe, expect, it } from 'vitest';
import { timeoutForModel, warmupRequestFor, type ModelDescriptor } from '@datera/core';

/**
 * Latency policy for local models (#33).
 *
 * The original report: a 14b model on a MacBook Air took 45 seconds with no feedback, and
 * could exceed the flat 120-second timeout. The bundled tier now warms itself, but a
 * runtime the user installed — Ollama, LM Studio — got none of that, and a timeout tuned
 * for a datacentre is the wrong number for a laptop loading four gigabytes off SSD.
 *
 * Two policies, both pure and both here rather than in three call sites.
 */
const local: ModelDescriptor = {
  tier: 'detected', provider: 'ollama', id: 'llama3.1:8b',
  role: 'chat', locality: 'local', endpoint: 'http://localhost:11434', label: 'x',
};
const remote: ModelDescriptor = {
  tier: 'remote', provider: 'anthropic', id: 'claude-sonnet-5',
  role: 'chat', locality: 'remote', label: 'x',
};
const bundled: ModelDescriptor = {
  tier: 'bundled', provider: 'bundled', id: 'qwen2.5-coder-3b-instruct-q4_k_m',
  role: 'chat', locality: 'local', label: 'x',
};

describe('timeoutForModel', () => {
  it('gives a local model far longer than a remote one', () => {
    // A remote call that takes two minutes has failed. A local one may simply be loading.
    expect(timeoutForModel(local)).toBeGreaterThan(timeoutForModel(remote));
  });

  it('keeps the remote timeout short enough to be actionable', () => {
    // Past a minute, a remote provider is not slow — it is broken, and waiting longer
    // only delays telling the user that.
    expect(timeoutForModel(remote)).toBeLessThanOrEqual(90_000);
  });

  it('allows for a cold model load locally', () => {
    // Measured on this project: 35s for a first generation straight after a download,
    // almost all of it reading weights off disk. A 120s ceiling left very little room.
    expect(timeoutForModel(local)).toBeGreaterThanOrEqual(300_000);
    expect(timeoutForModel(bundled)).toBeGreaterThanOrEqual(300_000);
  });

  it('is bounded, because a hang has to end somewhere', () => {
    for (const model of [local, remote, bundled]) {
      expect(timeoutForModel(model)).toBeLessThanOrEqual(15 * 60_000);
    }
  });
});

describe('warmupRequestFor', () => {
  it('asks a local runtime for almost nothing, to make it load the weights', () => {
    const request = warmupRequestFor(local);
    expect(request).not.toBeNull();
    // One token. The answer is discarded — the point is the load, and paying for a real
    // generation to achieve it would be waste on a metered tier.
    expect(request?.maxTokens).toBeLessThanOrEqual(2);
  });

  it('warms the bundled tier too', () => {
    expect(warmupRequestFor(bundled)).not.toBeNull();
  });

  it('never warms a remote model', () => {
    // There is nothing to warm, and a request to a metered API that exists only to make
    // the next one faster is someone's money spent on nothing.
    expect(warmupRequestFor(remote)).toBeNull();
  });
});
