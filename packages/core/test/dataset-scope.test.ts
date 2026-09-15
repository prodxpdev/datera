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
 * Acceptance §12.4 — sources in different datasets cannot be joined.
 *
 * Spec §3 makes the dataset "the one boundary that governs everything". This suite is
 * that claim under load: it is not enough that unqualified names resolve inside the
 * active dataset, because a user or a model can always write `ds_other.table` explicitly.
 * The boundary has to be enforced, not merely defaulted to.
 *
 * Both halves of §12.4 are covered — the model is only ever shown the active dataset's
 * schema, and a hand-written cross-dataset join is blocked at execution.
 */
describe('§12.4 the dataset boundary', () => {
  let ws: TestWorkspace;
  let server: StubModelServer;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });

    // Two datasets that deliberately have nothing to do with each other — the exact
    // situation the boundary exists for.
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });

    await ws.datera.createDataset({ id: 'marketing', name: 'Marketing analysis' });
    await ws.datera.addSource({
      type: 'file', path: fixtures.notesNdjson, name: 'notes', datasetId: 'marketing',
    });

    await ws.datera.setChatModel({
      tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
      locality: 'local', endpoint: server.url, label: 'llama3.1:8b',
    });
  });

  afterEach(async () => {
    await ws.dispose();
    await server.close();
  });

  describe('a cross-dataset join is blocked at execution', () => {
    it('blocks a fully qualified reference to another dataset', async () => {
      await expect(
        ws.datera.query(DEFAULT_DATASET_ID, 'SELECT * FROM ds_marketing_analysis.notes'),
      ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
    });

    it('blocks a join that reaches across datasets', async () => {
      await expect(
        ws.datera.query(
          DEFAULT_DATASET_ID,
          'SELECT * FROM orders o JOIN ds_marketing_analysis.notes n ON n.order_id = o.order_id',
        ),
      ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
    });

    it('blocks a reference hidden inside a CTE', async () => {
      // The AST is walked rather than the text scanned, so nesting does not help.
      await expect(
        ws.datera.query(
          DEFAULT_DATASET_ID,
          'WITH sneaky AS (SELECT * FROM ds_marketing_analysis.notes) SELECT * FROM sneaky',
        ),
      ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
    });

    it('blocks a reference hidden inside a subquery', async () => {
      await expect(
        ws.datera.query(
          DEFAULT_DATASET_ID,
          'SELECT count(*) FROM (SELECT * FROM ds_marketing_analysis.notes) t',
        ),
      ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
    });

    it('blocks a reference in a scalar subquery in the select list', async () => {
      await expect(
        ws.datera.query(
          DEFAULT_DATASET_ID,
          'SELECT (SELECT count(*) FROM ds_marketing_analysis.notes) AS n, count(*) FROM orders',
        ),
      ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
    });

    it('blocks reading Datera’s own bookkeeping through the user query path', async () => {
      await expect(
        ws.datera.query(DEFAULT_DATASET_ID, 'SELECT * FROM _datera.sources'),
      ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
    });

    it('names what was refused, so the message is actionable', async () => {
      const error = await ws.datera
        .query(DEFAULT_DATASET_ID, 'SELECT * FROM ds_marketing_analysis.notes')
        .then(() => null)
        .catch((e: unknown) => e as { message: string; details: Record<string, unknown> });

      expect(error?.message).toContain('Marketing analysis');
      expect(String(error?.details['offending'])).toContain('notes');
    });
  });

  describe('queries inside one dataset still work normally', () => {
    it('allows unqualified names in the active dataset', async () => {
      const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders');
      expect(Number(result.rows[0]?.[0])).toBe(6);
    });

    it('allows a fully qualified name for the active dataset', async () => {
      const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM ds_ungrouped.orders');
      expect(Number(result.rows[0]?.[0])).toBe(6);
    });

    it('allows CTEs, subqueries and joins within one dataset', async () => {
      const result = await ws.datera.query(
        DEFAULT_DATASET_ID,
        `WITH by_product AS (SELECT product, sum(revenue_cents) AS r FROM orders GROUP BY product)
         SELECT count(*) FROM by_product WHERE r > 0`,
      );
      expect(Number(result.rows[0]?.[0])).toBeGreaterThan(0);
    });

    it('allows table functions and literals, which reference no table at all', async () => {
      const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT 1 + 1 AS two');
      expect(Number(result.rows[0]?.[0])).toBe(2);
    });

    it('lets the other dataset query its own sources', async () => {
      const result = await ws.datera.query('marketing', 'SELECT count(*) FROM notes');
      expect(Number(result.rows[0]?.[0])).toBe(3);
    });
  });

  describe('the model is only ever shown the active dataset', () => {
    it('sends no trace of another dataset’s tables', async () => {
      server.setReply('SELECT count(*) FROM orders');
      await ws.datera.ask(DEFAULT_DATASET_ID, 'how many orders');

      const sent = JSON.stringify(server.requests.at(-1)?.json ?? {});
      expect(sent).toContain('orders');
      // `notes` lives in the other dataset. The model must not know it exists — that is
      // how §12.4 stops nonsense joins being generated in the first place.
      expect(sent).not.toContain('notes');
      expect(sent).not.toContain('ds_marketing');
    });

    it('refuses a model-generated cross-dataset join, if one ever appears', async () => {
      // Defence in depth: even if a model somehow learned of the other schema, the same
      // boundary applies to generated SQL as to hand-written SQL.
      server.setReply('SELECT * FROM orders o JOIN ds_marketing_analysis.notes n ON n.order_id = o.order_id');

      const answer = await ws.datera.ask(DEFAULT_DATASET_ID, 'join everything');
      expect(answer.answerable).toBe(false);
      expect(answer.flag).toMatch(/dataset/i);
    });
  });
});
