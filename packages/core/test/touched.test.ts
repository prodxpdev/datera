import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import { fixturePaths, openTestWorkspace, testPorts, type FixturePaths, type TestWorkspace } from '@datera/testkit';

/**
 * "What it touched" — the physical drill-down (spec §5).
 *
 * Column *roles* are the interesting part: the drawer has to distinguish a column used as
 * a join key from one that happens to be selected, and that distinction comes from where
 * the column sits in the parse tree rather than from matching names in the SQL text.
 */
describe('§5 what it touched', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'support_notes' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('reports a single-source read as a sheet, with the filter that matched', async () => {
    const touched = await ws.datera.explainTouched(
      DEFAULT_DATASET_ID,
      `SELECT product, revenue_cents FROM orders WHERE refunded = false`,
    );

    expect(touched.shape).toBe('sheet');
    expect(touched.tables.map((t) => t.table)).toEqual(['orders']);
    expect(touched.filter).toContain('refunded');
    expect(touched.rowsScanned).toBe(6);
  });

  it('labels each column with the role it played', async () => {
    const touched = await ws.datera.explainTouched(
      DEFAULT_DATASET_ID,
      `SELECT product, sum(revenue_cents) FROM orders WHERE refunded = false GROUP BY product`,
    );

    const role = (name: string): string | null =>
      touched.tables[0]?.columns.find((c) => c.column === name)?.role ?? null;

    expect(role('product')).toBe('group');
    expect(role('revenue_cents')).toBe('aggregate');
    expect(role('refunded')).toBe('filter');
    // Columns the query never mentioned are listed with no role — "what was ignored" is
    // as informative as what was read.
    expect(role('qty')).toBeNull();
  });

  it('reports a join, with the join path and the join keys', async () => {
    const touched = await ws.datera.explainTouched(
      DEFAULT_DATASET_ID,
      `SELECT o.product, n.note
       FROM orders o JOIN support_notes n ON n.order_id = o.order_id
       WHERE o.refunded = false`,
    );

    expect(touched.shape).toBe('join');
    expect(touched.tables.map((t) => t.table).sort()).toEqual(['orders', 'support_notes']);
    expect(touched.joinPath.join(' ')).toContain('order_id');

    const orders = touched.tables.find((t) => t.table === 'orders');
    expect(orders?.columns.find((c) => c.column === 'order_id')?.role).toBe('join');
    expect(orders?.columns.find((c) => c.column === 'refunded')?.role).toBe('filter');
  });

  it('distinguishes a join key from a merely selected column', async () => {
    // The distinction the drawer exists to show. Matching names against the SQL text
    // could not tell these apart.
    const touched = await ws.datera.explainTouched(
      DEFAULT_DATASET_ID,
      `SELECT o.product FROM orders o JOIN support_notes n ON n.order_id = o.order_id`,
    );

    const orders = touched.tables.find((t) => t.table === 'orders');
    expect(orders?.columns.find((c) => c.column === 'order_id')?.role).toBe('join');
    expect(orders?.columns.find((c) => c.column === 'product')?.role).toBe('select');
  });

  it('reports no filter when there is none', async () => {
    const touched = await ws.datera.explainTouched(DEFAULT_DATASET_ID, 'SELECT * FROM orders');
    expect(touched.filter).toBeNull();
    expect(touched.joinPath).toEqual([]);
  });

  it('refuses to explain a statement that breaks the dataset boundary', async () => {
    await ws.datera.createDataset({ id: 'other', name: 'Other' });
    await expect(
      ws.datera.explainTouched(DEFAULT_DATASET_ID, 'SELECT * FROM ds_other.nothing'),
    ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
  });
});
