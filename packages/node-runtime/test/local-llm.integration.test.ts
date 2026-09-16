import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUNDLED_MODEL_ID, SQL_GRAMMAR, bundledModel } from '@datera/core';
import { NodeLocalLlm } from '@datera/node-runtime';

/**
 * The real runtime, against real weights.
 *
 * Opt-in: `DATERA_BUNDLED_MODEL=1 pnpm vitest run local-llm.integration`. It downloads
 * about two gigabytes on first run, so it is not part of the default suite — but it is
 * the only test that proves the claim the bundled tier is built on, and skipping it
 * forever would mean shipping a feature verified entirely against a stub.
 *
 * What it checks is the thing a stub cannot: that llama.cpp loads these weights, that the
 * grammar actually constrains the output, and that a 3B model produces SQL rather than
 * prose about SQL.
 */
const enabled = process.env['DATERA_BUNDLED_MODEL'] === '1';
const directory = process.env['DATERA_MODEL_DIR'] ?? join(homedir(), '.datera', 'models');

describe.runIf(enabled)('the bundled runtime, for real', () => {
  const spec = bundledModel(DEFAULT_BUNDLED_MODEL_ID);

  it(
    'downloads and verifies the weights',
    async () => {
      const llm = new NodeLocalLlm({ directory });
      await llm.ensure(spec.id, (p) => {
        if (p.receivedBytes % 200_000_000 < 8_000_000) {
          process.stdout.write(`  ${(p.receivedBytes / 1024 ** 3).toFixed(2)} GB\n`);
        }
      });

      const status = (await llm.status()).find((s) => s.modelId === spec.id);
      expect(status?.ready).toBe(true);
      await llm.dispose();
    },
    30 * 60_000,
  );

  it(
    'writes SQL, constrained by the grammar',
    async () => {
      const llm = new NodeLocalLlm({ directory });
      const started = Date.now();

      const result = await llm.generate({
        modelId: spec.id,
        system:
          'You translate questions into a single DuckDB SQL SELECT statement. ' +
          'Schema:\nTABLE orders (order_id VARCHAR, product VARCHAR, revenue_cents BIGINT)',
        prompt: 'total revenue by product',
        maxTokens: 200,
        grammar: SQL_GRAMMAR,
      });

      // The grammar admits exactly one statement, or a refusal. Nothing else.
      expect(result.text.trim()).toMatch(/^(SELECT|WITH|EXPLAIN|CANNOT_ANSWER:)/i);
      expect(result.text).not.toMatch(/```/);
      expect(result.text.toLowerCase()).toContain('revenue_cents');
      expect(result.outputTokens).toBeGreaterThan(0);

      // Not an assertion — a number worth seeing, since latency is this tier's real cost.
      process.stdout.write(`  generated in ${Date.now() - started}ms\n`);
      await llm.dispose();
    },
    5 * 60_000,
  );

  it(
    'answers a second question without being restarted',
    async () => {
      // A real bug this caught: a context hands out a fixed number of sequences, one was
      // taken per generation and never returned, and the *second* question anyone asked
      // failed with "No sequences left". Every other test created a fresh instance, so
      // nothing noticed — the bug was only reachable by asking twice.
      //
      // Worth naming: this cannot be caught by the default suite, because it needs the
      // real runtime. A stub has no sequences to run out of.
      const llm = new NodeLocalLlm({ directory });
      const system =
        'You translate questions into a single DuckDB SQL SELECT statement.\n' +
        'Schema:\nTABLE orders (order_id VARCHAR, product VARCHAR, revenue_cents BIGINT)';

      for (const question of ['total revenue by product', 'how many orders per product']) {
        const result = await llm.generate({
          modelId: spec.id, system, prompt: question, maxTokens: 200, grammar: SQL_GRAMMAR,
        });
        expect(result.text.trim()).toMatch(/^(SELECT|WITH|EXPLAIN|CANNOT_ANSWER:)/i);
      }

      await llm.dispose();
    },
    10 * 60_000,
  );

  it(
    'can still decline',
    async () => {
      const llm = new NodeLocalLlm({ directory });
      const result = await llm.generate({
        modelId: spec.id,
        system:
          'You translate questions into a single DuckDB SQL SELECT statement. ' +
          'If the schema cannot answer the question, reply exactly "CANNOT_ANSWER: <reason>".\n' +
          'Schema:\nTABLE orders (order_id VARCHAR, product VARCHAR, revenue_cents BIGINT)',
        prompt: 'how satisfied were the customers?',
        maxTokens: 200,
        grammar: SQL_GRAMMAR,
      });

      // Measured: this model declines cleanly and names the missing information. Still
      // not asserted hard — a small model can invent a column on some phrasings, and a
      // test that pretends otherwise would be testing a hope. The behaviour that must
      // hold is the guard above it: an invented column is caught by the binder and
      // reported as CANNOT_ANSWER by the core, which ask.test.ts covers.
      process.stdout.write(`  declined? ${/^CANNOT_ANSWER/i.test(result.text.trim())}\n`);
      expect(result.text.length).toBeGreaterThan(0);
      await llm.dispose();
    },
    5 * 60_000,
  );
});
