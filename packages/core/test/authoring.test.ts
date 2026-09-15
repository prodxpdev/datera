import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import { fixturePaths, openTestWorkspace, type TestWorkspace } from '@datera/testkit';

/**
 * P1-21 — the "author from intent" seam (spec §3a).
 *
 * This suite is not testing a feature. There is no authoring UI, no AI-schema import, and
 * no code generation in Phase 1, and there should not be. What it tests is a *structural*
 * claim: that the core data model permits a dataset and its tables, columns, types and
 * relationships to be created directly, with no source attached — and that the result is
 * indistinguishable, to everything downstream, from a dataset built by connecting a file.
 *
 * If that claim ever stops holding, "a dataset comes from a file" will have leaked into
 * the model, and the later authoring work will be an excavation rather than an addition.
 */
describe('P1-21 authoring a dataset with no source', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace();
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('creates a dataset with nothing connected to it', async () => {
    const dataset = await ws.datera.createDataset({
      id: 'shop',
      name: 'Shop model',
      description: 'Authored from intent, before any data exists.',
    });

    expect(dataset.id).toBe('shop');
    expect(dataset.schemaName).toBe('ds_shop_model');
    expect(dataset.isDefault).toBe(false);

    // The defining assertion: a dataset that exists with no sources at all.
    const sources = await ws.datera.listSources();
    expect(sources.filter((s) => s.datasetId === 'shop')).toHaveLength(0);
    expect(await ws.datera.listTables('shop')).toHaveLength(0);
  });

  it('defines a typed table and introspects it back', async () => {
    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });

    const schema = await ws.datera.defineTable('shop', {
      name: 'customers',
      columns: [
        { name: 'id', type: 'UUID', primaryKey: true },
        { name: 'email', type: 'VARCHAR', nullable: false },
        { name: 'name', type: 'VARCHAR' },
        { name: 'lifetime_value_cents', type: 'BIGINT' },
        { name: 'signed_up_at', type: 'TIMESTAMP' },
      ],
    });

    expect(schema.sourceName).toBe('customers');
    // Null source id is the point: this table has no source behind it.
    expect(schema.sourceId).toBeNull();
    expect(schema.rowCount).toBe(0);
    expect(schema.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'UUID'],
      ['email', 'VARCHAR'],
      ['name', 'VARCHAR'],
      ['lifetime_value_cents', 'BIGINT'],
      ['signed_up_at', 'TIMESTAMP'],
    ]);

    // Declared constraints survive the round trip.
    expect(schema.columns.find((c) => c.name === 'email')?.declaredNullable).toBe(false);
    expect(schema.columns.find((c) => c.name === 'name')?.declaredNullable).toBe(true);
  });

  it('defines a relationship between two authored tables', async () => {
    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });
    await ws.datera.defineTable('shop', {
      name: 'customers',
      columns: [{ name: 'id', type: 'UUID', primaryKey: true }],
    });
    await ws.datera.defineTable('shop', {
      name: 'orders',
      columns: [
        { name: 'id', type: 'UUID', primaryKey: true },
        { name: 'customer_id', type: 'UUID' },
        { name: 'revenue_cents', type: 'BIGINT' },
      ],
    });

    const relationship = await ws.datera.defineRelationship('shop', {
      fromTable: 'orders',
      fromColumn: 'customer_id',
      toTable: 'customers',
      toColumn: 'id',
    });

    expect(relationship).toMatchObject({
      datasetId: 'shop',
      fromTable: 'orders',
      fromColumn: 'customer_id',
      toTable: 'customers',
      toColumn: 'id',
      state: 'confirmed',
    });

    expect(await ws.datera.listRelationships('shop')).toHaveLength(1);
    expect(await ws.datera.listRelationships(DEFAULT_DATASET_ID)).toHaveLength(0);
  });

  it('refuses a relationship whose column does not exist', async () => {
    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });
    await ws.datera.defineTable('shop', {
      name: 'customers',
      columns: [{ name: 'id', type: 'UUID' }],
    });
    await ws.datera.defineTable('shop', {
      name: 'orders',
      columns: [{ name: 'id', type: 'UUID' }],
    });

    await expect(
      ws.datera.defineRelationship('shop', {
        fromTable: 'orders',
        fromColumn: 'nope',
        toTable: 'customers',
        toColumn: 'id',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('authored tables and connected sources are queryable the same way', async () => {
    // The real payload of the seam: once defined, an authored table is not a second-class
    // object. The read-only query path does not know or care which entry path made it.
    const fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });

    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });
    await ws.datera.defineTable('shop', {
      name: 'products',
      columns: [
        { name: 'sku', type: 'VARCHAR' },
        { name: 'price_cents', type: 'BIGINT' },
      ],
    });

    const connected = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) AS n FROM orders');
    const authored = await ws.datera.query('shop', 'SELECT count(*) AS n FROM products');

    expect(Number(connected.rows[0]?.[0])).toBe(6);
    expect(Number(authored.rows[0]?.[0])).toBe(0);

    // And the read-only guard applies identically to both.
    await expect(ws.datera.query('shop', `INSERT INTO products VALUES ('x', 1)`)).rejects.toMatchObject(
      { code: 'READ_ONLY_VIOLATION' },
    );
  });

  it('survives a workspace restart', async () => {
    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });
    await ws.datera.defineTable('shop', {
      name: 'customers',
      columns: [{ name: 'id', type: 'UUID' }],
    });
    await ws.datera.defineTable('shop', {
      name: 'orders',
      columns: [
        { name: 'id', type: 'UUID' },
        { name: 'customer_id', type: 'UUID' },
      ],
    });
    await ws.datera.defineRelationship('shop', {
      fromTable: 'orders',
      fromColumn: 'customer_id',
      toTable: 'customers',
      toColumn: 'id',
    });

    ws = await ws.reopen();

    const datasets = await ws.datera.listDatasets();
    expect(datasets.map((d) => d.id)).toContain('shop');
    expect(await ws.datera.listTables('shop')).toEqual(['customers', 'orders']);
    expect(await ws.datera.listRelationships('shop')).toHaveLength(1);

    const schema = await ws.datera.describeTable('shop', 'orders');
    expect(schema.columns.map((c) => c.name)).toEqual(['id', 'customer_id']);
  });

  it('refuses a column type it will not author, rather than interpolating it', async () => {
    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });

    // A type name cannot be a bound parameter, so it is the one injection surface an
    // authored schema has. It is an allowlist, not an escape.
    await expect(
      ws.datera.defineTable('shop', {
        name: 'evil',
        columns: [{ name: 'a', type: 'INTEGER); DROP TABLE customers; --' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(
      ws.datera.defineTable('shop', { name: 'evil2', columns: [{ name: 'a', type: 'NOT_A_TYPE' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('accepts parameterised and array types', async () => {
    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });
    const schema = await ws.datera.defineTable('shop', {
      name: 'ledger',
      columns: [
        { name: 'amount', type: 'DECIMAL(12,2)' },
        { name: 'tags', type: 'VARCHAR[]' },
      ],
    });
    expect(schema.columns.map((c) => c.type)).toEqual(['DECIMAL(12,2)', 'VARCHAR[]']);
  });

  it('refuses a duplicate column name', async () => {
    await ws.datera.createDataset({ id: 'shop', name: 'Shop model' });
    await expect(
      ws.datera.defineTable('shop', {
        name: 'dupes',
        columns: [
          { name: 'id', type: 'BIGINT' },
          { name: 'ID', type: 'VARCHAR' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
  });

  it('keeps authored datasets in separate schemas', async () => {
    // The dataset boundary (spec §3) has to hold for authored datasets too, or §12.4 is
    // only true for datasets that happen to have come from files.
    const a = await ws.datera.createDataset({ id: 'a', name: 'Alpha' });
    const b = await ws.datera.createDataset({ id: 'b', name: 'Beta' });
    expect(a.schemaName).not.toBe(b.schemaName);

    await ws.datera.defineTable('a', { name: 'shared_name', columns: [{ name: 'x', type: 'BIGINT' }] });
    await ws.datera.defineTable('b', { name: 'shared_name', columns: [{ name: 'y', type: 'VARCHAR' }] });

    expect((await ws.datera.describeTable('a', 'shared_name')).columns[0]?.name).toBe('x');
    expect((await ws.datera.describeTable('b', 'shared_name')).columns[0]?.name).toBe('y');
  });
});
