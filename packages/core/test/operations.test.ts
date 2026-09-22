import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths, openTestWorkspace, testPorts,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * Authored operations — named, typed, parameterised statements (spec §8, §3a).
 *
 * The gap this fills: the generated tools are `query_<dataset>(sql)` and
 * `propose_write_<dataset>(sql)`. An agent can do anything or nothing, and there is no way
 * to say "this workspace offers `create_order(customer_id, product, qty)` and that is the
 * shape of it".
 *
 * Three things make this Datera rather than a code generator, and each is a test below:
 *
 *  - **Parameters are bound, never interpolated.** An authored operation that pasted its
 *    arguments into SQL would make every one of them an injection hole.
 *  - **The kind is measured, not declared.** Someone naming a DELETE `create_order` must
 *    not have it treated as a read.
 *  - **A write operation proposes; it does not apply.** §6 says a write is never executed
 *    without an explicit confirm, and an agent cannot confirm. Calling one returns a
 *    proposal for a human to ratify, exactly like every other write path.
 */
describe('authored operations', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let writableId: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    writableId = (await ws.datera.enableWrites(DEFAULT_DATASET_ID)).datasetId;
  });

  afterEach(async () => {
    await ws.dispose();
  });

  describe('authoring', () => {
    it('stores a named read with typed parameters', async () => {
      const op = await ws.datera.createOperation({
        datasetId: DEFAULT_DATASET_ID,
        name: 'revenue_for_product',
        description: 'Total revenue for one product.',
        sql: 'SELECT sum(revenue_cents) AS revenue FROM orders WHERE product = $product',
        parameters: [{ name: 'product', type: 'string', required: true, description: 'Exact product name' }],
      });

      expect(op.kind).toBe('read');
      expect((await ws.datera.listOperations(DEFAULT_DATASET_ID)).map((o) => o.name))
        .toEqual(['revenue_for_product']);
    });

    it('measures the kind rather than believing the name', async () => {
      const op = await ws.datera.createOperation({
        datasetId: writableId,
        name: 'create_order',
        description: 'Misleadingly named on purpose.',
        sql: 'DELETE FROM orders WHERE order_id = $order_id',
        parameters: [{ name: 'order_id', type: 'string', required: true, description: 'Order id' }],
      });

      expect(op.kind).toBe('write');
    });

    it('refuses a statement whose parameters do not match what was declared', async () => {
      // A declared parameter that the SQL never binds is a silent no-op; an undeclared
      // one in the SQL is a call that always fails. Both are better caught at authoring
      // time than at three in the morning by an agent.
      await expect(
        ws.datera.createOperation({
          datasetId: DEFAULT_DATASET_ID,
          name: 'mismatched',
          description: 'x',
          sql: 'SELECT * FROM orders WHERE product = $product',
          parameters: [{ name: 'thing', type: 'string', required: true, description: 'x' }],
        }),
      ).rejects.toThrow(/product|thing|parameter/i);
    });

    it('refuses a statement that reaches outside its dataset', async () => {
      await ws.datera.createDataset({ id: 'other', name: 'Other' });
      await expect(
        ws.datera.createOperation({
          datasetId: DEFAULT_DATASET_ID,
          name: 'reaches_out',
          description: 'x',
          sql: 'SELECT * FROM other.orders',
          parameters: [],
        }),
      ).rejects.toThrow();
    });

    it('refuses a name that would not be a usable tool name', async () => {
      await expect(
        ws.datera.createOperation({
          datasetId: DEFAULT_DATASET_ID,
          name: 'drop table; --',
          description: 'x',
          sql: 'SELECT 1 AS n',
          parameters: [],
        }),
      ).rejects.toThrow();
    });

    it('refuses a duplicate name in the same dataset', async () => {
      const input = {
        datasetId: DEFAULT_DATASET_ID,
        name: 'totals',
        description: 'x',
        sql: 'SELECT count(*) AS n FROM orders',
        parameters: [],
      };
      await ws.datera.createOperation(input);
      await expect(ws.datera.createOperation(input)).rejects.toThrow(/exists|duplicate/i);
    });

    it('deletes one', async () => {
      const op = await ws.datera.createOperation({
        datasetId: DEFAULT_DATASET_ID,
        name: 'totals',
        description: 'x',
        sql: 'SELECT count(*) AS n FROM orders',
        parameters: [],
      });
      await ws.datera.deleteOperation(op.id);
      expect(await ws.datera.listOperations(DEFAULT_DATASET_ID)).toEqual([]);
    });
  });

  describe('calling', () => {
    it('binds arguments rather than interpolating them', async () => {
      await ws.datera.createOperation({
        datasetId: DEFAULT_DATASET_ID,
        name: 'revenue_for_product',
        description: 'x',
        sql: 'SELECT sum(revenue_cents) AS revenue FROM orders WHERE product = $product',
        parameters: [{ name: 'product', type: 'string', required: true, description: 'x' }],
      });

      const result = await ws.datera.callOperation(DEFAULT_DATASET_ID, 'revenue_for_product', {
        product: 'Trail Hoodie',
      });

      expect(result.kind).toBe('read');
      expect(Number(result.rows?.[0]?.[0])).toBeGreaterThan(0);
    });

    it('treats an injection attempt as a value, because it is one', async () => {
      await ws.datera.createOperation({
        datasetId: DEFAULT_DATASET_ID,
        name: 'revenue_for_product',
        description: 'x',
        sql: 'SELECT sum(revenue_cents) AS revenue FROM orders WHERE product = $product',
        parameters: [{ name: 'product', type: 'string', required: true, description: 'x' }],
      });

      const result = await ws.datera.callOperation(DEFAULT_DATASET_ID, 'revenue_for_product', {
        product: "x'; DROP TABLE orders; --",
      });

      // No match, no error, and above all no second statement: it was bound as a string.
      expect(result.rows?.[0]?.[0] ?? null).toBeNull();
      expect(await ws.datera.listTables(DEFAULT_DATASET_ID)).toContain('orders');
    });

    it('refuses a call missing a required argument', async () => {
      await ws.datera.createOperation({
        datasetId: DEFAULT_DATASET_ID,
        name: 'revenue_for_product',
        description: 'x',
        sql: 'SELECT sum(revenue_cents) AS revenue FROM orders WHERE product = $product',
        parameters: [{ name: 'product', type: 'string', required: true, description: 'x' }],
      });

      await expect(
        ws.datera.callOperation(DEFAULT_DATASET_ID, 'revenue_for_product', {}),
      ).rejects.toThrow(/product|required/i);
    });

    it('proposes a write rather than applying it — §6, and an agent cannot confirm', async () => {
      await ws.datera.createOperation({
        datasetId: writableId,
        name: 'rename_product',
        description: 'x',
        sql: 'UPDATE orders SET product = $to WHERE product = $from',
        parameters: [
          { name: 'from', type: 'string', required: true, description: 'x' },
          { name: 'to', type: 'string', required: true, description: 'x' },
        ],
      });

      const before = await ws.datera.query(writableId, "SELECT count(*) FROM orders WHERE product = 'Renamed'");
      const result = await ws.datera.callOperation(writableId, 'rename_product', {
        from: 'Trail Hoodie', to: 'Renamed',
      });

      expect(result.kind).toBe('write');
      expect(result.proposal).not.toBeUndefined();
      expect(result.proposal?.rowsAffected).toBeGreaterThan(0);

      // Nothing changed. The proposal is an offer, exactly like every other write path.
      const after = await ws.datera.query(writableId, "SELECT count(*) FROM orders WHERE product = 'Renamed'");
      expect(after.rows[0]?.[0]).toEqual(before.rows[0]?.[0]);
    });

    it('applies once a human confirms that proposal', async () => {
      await ws.datera.createOperation({
        datasetId: writableId,
        name: 'rename_product',
        description: 'x',
        sql: 'UPDATE orders SET product = $to WHERE product = $from',
        parameters: [
          { name: 'from', type: 'string', required: true, description: 'x' },
          { name: 'to', type: 'string', required: true, description: 'x' },
        ],
      });

      const result = await ws.datera.callOperation(writableId, 'rename_product', {
        from: 'Trail Hoodie', to: 'Renamed',
      });
      await ws.datera.confirmWrite(result.proposal!.id);

      const after = await ws.datera.query(writableId, "SELECT count(*) FROM orders WHERE product = 'Renamed'");
      expect(Number(after.rows[0]?.[0])).toBeGreaterThan(0);
    });

    it('refuses a write operation on a dataset with no grant', async () => {
      await ws.datera.revokeWrite(writableId);
      await ws.datera.createOperation({
        datasetId: writableId,
        name: 'rename_product',
        description: 'x',
        sql: 'UPDATE orders SET product = $to WHERE product = $from',
        parameters: [
          { name: 'from', type: 'string', required: true, description: 'x' },
          { name: 'to', type: 'string', required: true, description: 'x' },
        ],
      });

      await expect(
        ws.datera.callOperation(writableId, 'rename_product', { from: 'a', to: 'b' }),
      ).rejects.toThrow(/write/i);
    });
  });

  describe('serving', () => {
    it('offers each operation as its own MCP tool, with its real parameters', async () => {
      await ws.datera.createOperation({
        datasetId: DEFAULT_DATASET_ID,
        name: 'revenue_for_product',
        description: 'Total revenue for one product.',
        sql: 'SELECT sum(revenue_cents) AS revenue FROM orders WHERE product = $product',
        parameters: [{ name: 'product', type: 'string', required: true, description: 'Exact product name' }],
      });

      const tool = (await ws.datera.listTools()).find((t) => t.name === 'revenue_for_product');

      expect(tool).toBeDefined();
      expect(tool?.description).toContain('Total revenue for one product.');
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['product']);
      expect(tool?.inputSchema.required).toEqual(['product']);
      // Not the generic sql-taking tool: an authored operation is the shape of the call.
      expect(tool?.inputSchema.properties['sql']).toBeUndefined();
    });

    it('says plainly in the tool description that a write will need confirming', async () => {
      await ws.datera.createOperation({
        datasetId: writableId,
        name: 'rename_product',
        description: 'Rename a product.',
        sql: 'UPDATE orders SET product = $to WHERE product = $from',
        parameters: [
          { name: 'from', type: 'string', required: true, description: 'x' },
          { name: 'to', type: 'string', required: true, description: 'x' },
        ],
      });

      const tool = (await ws.datera.listTools()).find((t) => t.name === 'rename_product');
      expect(tool?.description).toMatch(/propose|confirm/i);
    });

    it('does not advertise a write operation whose dataset has no grant', async () => {
      await ws.datera.createOperation({
        datasetId: writableId,
        name: 'rename_product',
        description: 'x',
        sql: 'UPDATE orders SET product = $to WHERE product = $from',
        parameters: [
          { name: 'from', type: 'string', required: true, description: 'x' },
          { name: 'to', type: 'string', required: true, description: 'x' },
        ],
      });
      await ws.datera.revokeWrite(writableId);

      // Datera does not advertise a tool that would fail when called.
      expect((await ws.datera.listTools()).map((t) => t.name)).not.toContain('rename_product');
    });

    it('is callable through the MCP tool path, not just the façade', async () => {
      await ws.datera.createOperation({
        datasetId: DEFAULT_DATASET_ID,
        name: 'order_count',
        description: 'How many orders.',
        sql: 'SELECT count(*) AS n FROM orders',
        parameters: [],
      });

      const result = await ws.datera.callTool('order_count', {});
      expect(JSON.stringify(result)).toMatch(/\d/);
    });
  });
});
