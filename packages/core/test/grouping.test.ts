import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  describeDifferences, fixturePaths, openTestWorkspace, testPorts, withUnchangedFiles,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * Grouping sources into datasets (spec §3).
 *
 * The dataset is "the one boundary that governs everything", so being able to *form* one
 * is not a convenience — without it every source lands in Ungrouped and the boundary has
 * nothing to separate. The engine could create datasets from Phase 3; moving a source
 * between them is what actually makes grouping usable, and is new here.
 */
describe('§3 grouping sources', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'notes' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('moves a source into another dataset', async () => {
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    const orders = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;

    await ws.datera.moveSource(orders.id, store.id);

    const moved = (await ws.datera.listSources()).find((s) => s.id === orders.id);
    expect(moved?.datasetId).toBe(store.id);
    expect(moved?.status.availability).toBe('available');
  });

  it('the source is queryable in its new dataset and gone from the old one', async () => {
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    const orders = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;
    await ws.datera.moveSource(orders.id, store.id);

    const here = await ws.datera.query(store.id, 'SELECT count(*) FROM orders');
    expect(Number(here.rows[0]?.[0])).toBe(6);

    // And the boundary holds from the other side: the old dataset can no longer see it.
    await expect(ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders')).rejects.toBeDefined();
  });

  it('never touches the underlying file (§1.1)', async () => {
    const { differences } = await withUnchangedFiles([fixtures.ordersCsv], async () => {
      const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
      const orders = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;
      await ws.datera.moveSource(orders.id, store.id);
    });
    expect(describeDifferences(differences)).toBe('');
  });

  it('groups two sources so they can be joined', async () => {
    // The point of grouping, per §3: sources that share a key end up somewhere they can
    // actually be queried together.
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    for (const source of await ws.datera.listSources()) {
      await ws.datera.moveSource(source.id, store.id);
    }

    const joined = await ws.datera.query(
      store.id,
      `SELECT count(*) FROM orders o JOIN notes n ON n.order_id = o.order_id`,
    );
    expect(Number(joined.rows[0]?.[0])).toBeGreaterThan(0);
  });

  it('disambiguates a name that already exists in the target dataset', async () => {
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders', datasetId: store.id });

    const original = (await ws.datera.listSources()).find(
      (s) => s.name === 'orders' && s.datasetId === DEFAULT_DATASET_ID,
    )!;
    await ws.datera.moveSource(original.id, store.id);

    const inStore = (await ws.datera.listSources()).filter((s) => s.datasetId === store.id);
    expect(inStore).toHaveLength(2);
    expect(new Set(inStore.map((s) => s.name)).size).toBe(2);
  });

  it('refuses to move into a dataset that does not exist', async () => {
    const orders = (await ws.datera.listSources())[0]!;
    await expect(ws.datera.moveSource(orders.id, 'nope')).rejects.toMatchObject({
      code: 'DATASET_NOT_FOUND',
    });
  });

  it('renames a dataset without disturbing its sources', async () => {
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    const orders = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;
    await ws.datera.moveSource(orders.id, store.id);

    await ws.datera.renameDataset(store.id, 'Sales exports');

    expect((await ws.datera.getDataset(store.id)).name).toBe('Sales exports');
    const result = await ws.datera.query(store.id, 'SELECT count(*) FROM orders');
    expect(Number(result.rows[0]?.[0])).toBe(6);
  });

  it('deletes an empty dataset', async () => {
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    await ws.datera.deleteDataset(store.id);

    expect((await ws.datera.listDatasets()).map((d) => d.id)).not.toContain('store');
  });

  it('refuses to delete a dataset that still holds sources', async () => {
    // Deleting a dataset with sources in it would either orphan them or silently drop
    // them. Refusing makes the user say what should happen to them first.
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    const orders = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;
    await ws.datera.moveSource(orders.id, store.id);

    await expect(ws.datera.deleteDataset(store.id)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('refuses to delete the default dataset', async () => {
    await expect(ws.datera.deleteDataset(DEFAULT_DATASET_ID)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('survives a restart', async () => {
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });
    const orders = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;
    await ws.datera.moveSource(orders.id, store.id);

    ws = await ws.reopen();

    const moved = (await ws.datera.listSources()).find((s) => s.name === 'orders');
    expect(moved?.datasetId).toBe('store');
    expect(moved?.status.availability).toBe('available');
  });

  it('moves an attached database source too', async () => {
    // A SQLite source is a view over an attached catalog, so moving it has to recreate
    // the view in the new schema rather than just relabel a row.
    await ws.datera.addSource({ type: 'sqlite', path: fixtures.customersSqlite });
    const store = await ws.datera.createDataset({ id: 'store', name: 'Store exports' });

    const customers = (await ws.datera.listSources()).find((s) => s.name === 'customers')!;
    await ws.datera.moveSource(customers.id, store.id);

    const result = await ws.datera.query(store.id, 'SELECT count(*) FROM customers');
    expect(Number(result.rows[0]?.[0])).toBe(3);
  });
});
