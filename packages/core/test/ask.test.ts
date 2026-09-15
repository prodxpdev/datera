import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths,
  openTestWorkspace,
  startStubModelServer,
  testPorts,
  type FixturePaths,
  type StubModelServer,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * Phase 2 acceptance — NL→SQL with the glass box (spec §5, §12.2, §12.3, §1.5).
 *
 * The assertions that matter most here are about what Datera **does not** do: it does not
 * send data rows to the model, and it does not produce a number it cannot back with rows.
 * Both are only checkable because the stub server records the exact payload.
 */
describe('Ask — NL→SQL with citations and a trace', () => {
  let ws: TestWorkspace;
  let server: StubModelServer;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });

    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.setChatModel({
      tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
      locality: 'local', endpoint: server.url, label: 'llama3.1:8b',
    });
  });

  afterEach(async () => {
    await ws.dispose();
    await server.close();
  });

  describe('§12.2 — a cited answer, with the SQL shown', () => {
    it('generates SQL, runs it, and returns rows with the SQL visible', async () => {
      server.setReply('```sql\nSELECT product, sum(revenue_cents) AS revenue FROM orders GROUP BY product ORDER BY revenue DESC\n```');

      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'top products by revenue');

      expect(answer.sql).toContain('SELECT product');
      // Fenced code must be unwrapped — a model that returns markdown is the normal case.
      expect(answer.sql).not.toContain('```');
      expect(answer.rows.length).toBeGreaterThan(0);
      expect(answer.columns.map((c) => c.name)).toEqual(['product', 'revenue']);
    });

    it('cites the columns and the row count it actually touched', async () => {
      server.setReply('SELECT product, sum(revenue_cents) AS revenue FROM orders GROUP BY product');

      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'revenue by product');

      expect(answer.citations.sources).toContain('orders');
      expect(answer.citations.columns).toEqual(expect.arrayContaining(['product', 'revenue_cents']));
      expect(answer.citations.rowCount).toBe(answer.rows.length);
    });

    it('sends the schema to the model and NO data rows', async () => {
      server.setReply('SELECT count(*) FROM orders');
      await ws.datera.ask(DEFAULT_DATASET_ID, 'how many orders');

      const sent = JSON.stringify(server.requests.at(-1)?.json ?? {});

      // Schema is expected and required for good SQL.
      expect(sent).toContain('orders');
      expect(sent).toContain('revenue_cents');
      expect(sent).toContain('BIGINT');

      // Actual values from the file must never appear. These are real cell values in
      // fixtures/orders.csv; if any reaches the payload, invariant §1.4 is broken.
      for (const value of ['A-1042', 'Trail Hoodie', 'Wool Beanie', '8900', 'Summit Pack']) {
        expect(sent, `the model payload contained the data value "${value}"`).not.toContain(value);
      }
    });

    it('records the exact payload it sent, so the drawer can show it', async () => {
      server.setReply('SELECT count(*) FROM orders');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'how many orders');

      const modelStage = answer.trace.stages.find((s) => s.kind === 'model');
      expect(modelStage).toBeDefined();
      expect(modelStage?.modelPayload).toBeDefined();
      // What is recorded must be what was sent, or the drawer is decorative.
      expect(JSON.stringify(server.requests.at(-1)?.json)).toContain(
        (modelStage?.modelPayload ?? '').slice(0, 60).replace(/\n/g, '\\n'),
      );
    });
  });

  describe('§12.3 — a question that cannot be answered honestly is flagged, not invented', () => {
    it('flags when the model declines rather than fabricating a value', async () => {
      server.setReply('CANNOT_ANSWER: the dataset has no column describing customer sentiment');

      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'how happy were my customers?');

      expect(answer.answerable).toBe(false);
      expect(answer.rows).toEqual([]);
      expect(answer.flag).toContain('sentiment');
      expect(answer.sql).toBeNull();
    });

    it('flags when the model invents a column that does not exist', async () => {
      // The most common local-model failure: confident SQL over a hallucinated column.
      // It must surface as "cannot answer", never as a number.
      server.setReply('SELECT avg(customer_happiness) FROM orders');

      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'average happiness');

      expect(answer.answerable).toBe(false);
      expect(answer.flag).toMatch(/customer_happiness|does not exist/i);
      expect(answer.rows).toEqual([]);
    });

    it('refuses a model-proposed write, loudly', async () => {
      // An NL instruction that turns into a DELETE is the footgun in spec §6. In a
      // read-only phase it must be refused outright, not executed and not silently ignored.
      server.setReply('DELETE FROM orders WHERE refunded = true');

      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'get rid of the refunded orders');

      expect(answer.answerable).toBe(false);
      expect(answer.flag).toMatch(/read-only|refused/i);

      // And the source is untouched: still six rows.
      const check = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders');
      expect(Number(check.rows[0]?.[0])).toBe(6);
    });

    it('flags an empty result rather than implying zero is an answer', async () => {
      server.setReply(`SELECT * FROM orders WHERE product = 'Nonexistent Product'`);

      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'orders for a product I never sold');

      expect(answer.answerable).toBe(true);
      expect(answer.rows).toEqual([]);
      expect(answer.flag).toMatch(/no rows/i);
    });
  });

  describe('§1.5 — deterministic where facts matter', () => {
    it('computes row counts and timings in code, not from the model', async () => {
      server.setReply('SELECT * FROM orders');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'everything');

      expect(answer.citations.rowCount).toBe(6);
      expect(answer.trace.totalMs).toBeGreaterThanOrEqual(0);

      const exec = answer.trace.stages.find((s) => s.kind === 'execute');
      expect(exec?.rowCount).toBe(6);
    });

    it('runs the same SQL the user is shown', async () => {
      // If the displayed SQL and the executed SQL could differ, the glass box is a lie.
      server.setReply('SELECT product FROM orders LIMIT 2');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'two products');

      const sqlStage = answer.trace.stages.find((s) => s.kind === 'sql');
      expect(sqlStage?.sql).toBe(answer.sql);
      expect(answer.rows).toHaveLength(2);
    });
  });

  describe('the trace (spec §1.4, §9)', () => {
    it('covers every stage in order', async () => {
      server.setReply('SELECT count(*) FROM orders');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'count');

      expect(answer.trace.stages.map((s) => s.kind)).toEqual([
        'parse', 'route', 'schema', 'model', 'sql', 'guard', 'execute',
      ]);
    });

    it('names the exact model, never just “the local model”', async () => {
      server.setReply('SELECT 1');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'anything');

      const model = answer.trace.stages.find((s) => s.kind === 'model');
      expect(model?.model?.id).toBe('llama3.1:8b');
      expect(model?.model?.tier).toBe('detected');
      expect(model?.modelName).toContain('Ollama · llama3.1:8b');
      expect(model?.modelName).toContain('local');
      expect(model?.modelName).not.toBe('the local model');
    });

    it('reports cost, and shows zero for a local model', async () => {
      server.setReply('SELECT 1');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'anything');

      expect(answer.trace.costUsd).toBe(0);
      expect(answer.trace.inputTokens).toBeGreaterThan(0);
    });

    it('records the routing decision and its reason', async () => {
      server.setReply('SELECT 1');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'count the orders');

      const route = answer.trace.stages.find((s) => s.kind === 'route');
      expect(route?.route).toBe('structured');
      expect(route?.detail).toBeTruthy();
    });

    it('records the guard verdict for the generated SQL', async () => {
      server.setReply('SELECT count(*) FROM orders');
      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'count');

      const guard = answer.trace.stages.find((s) => s.kind === 'guard');
      expect(guard?.detail).toMatch(/read-only/i);
    });
  });

  describe('when no model is configured', () => {
    it('says so plainly instead of failing obscurely', async () => {
      const bare = await openTestWorkspace({ ports: testPorts({ http: true }) });
      try {
        await bare.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
        await expect(bare.datera.ask(DEFAULT_DATASET_ID, 'anything')).rejects.toMatchObject({
          code: 'MODEL_UNAVAILABLE',
        });
      } finally {
        await bare.dispose();
      }
    });
  });
});
