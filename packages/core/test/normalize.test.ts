import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  describeDifferences, fixturePaths, openTestWorkspace, testPorts, withUnchangedFiles,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * §7 — flat sheet to relational.
 *
 * The fixture has three customers and three products across nine orders, so every
 * proposal below can be checked by hand. That matters: normalization is proposed for a
 * human to ratify (§1.3), and a fixture whose structure is not obvious cannot tell you
 * whether the proposal was right.
 */
describe('§7 normalization', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let sourceId: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.flatSheetCsv, name: 'sheet' });
    sourceId = source!.id;
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('spots the repeating entities in a flat sheet', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);
    const keys = proposal.entities.map((e) => e.keyColumn);

    expect(keys).toContain('customer_email');
    expect(keys).toContain('product_sku');
  });

  it('groups the attributes that travel with each key', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);

    const customer = proposal.entities.find((e) => e.keyColumn === 'customer_email');
    expect(customer?.attributeColumns).toEqual(
      expect.arrayContaining(['customer_name', 'customer_city']),
    );

    const product = proposal.entities.find((e) => e.keyColumn === 'product_sku');
    expect(product?.attributeColumns).toEqual(
      expect.arrayContaining(['product_name', 'product_category']),
    );
  });

  it('shows the repetition it measured, so the proposal can be evaluated', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);
    const customer = proposal.entities.find((e) => e.keyColumn === 'customer_email');

    expect(customer?.distinctValues).toBe(3);
    expect(customer?.totalRows).toBe(9);
    expect(customer?.evidence).toContain('3 distinct values');
    expect(customer?.evidence).toContain('9 rows');
  });

  it('does not propose an entity for a column that never repeats', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);
    // order_id is unique per row — it is the fact's key, not a hidden entity.
    expect(proposal.entities.map((e) => e.keyColumn)).not.toContain('order_id');
  });

  it('proposing alone changes nothing', async () => {
    await ws.datera.proposeNormalization(sourceId);
    expect(await ws.datera.listDatasets()).toHaveLength(1);
    expect(await ws.datera.listTables(DEFAULT_DATASET_ID)).toEqual(['sheet']);
  });

  it('applies into a derived dataset, leaving the source byte-identical (§12.6)', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);

    const { result, differences } = await withUnchangedFiles([fixtures.flatSheetCsv], async () =>
      ws.datera.applyNormalization(DEFAULT_DATASET_ID, proposal, { name: 'Modelled' }),
    );

    expect(describeDifferences(differences)).toBe('');
    expect(result.tables).toEqual(expect.arrayContaining(['customers', 'products', 'sheet']));

    // The original dataset is exactly as it was.
    expect(await ws.datera.listTables(DEFAULT_DATASET_ID)).toEqual(['sheet']);
  });

  it('produces entity tables with one row per distinct key', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);
    const derived = await ws.datera.applyNormalization(DEFAULT_DATASET_ID, proposal, { name: 'Modelled' });

    const customers = await ws.datera.query(derived.datasetId, 'SELECT count(*) FROM customers');
    expect(Number(customers.rows[0]?.[0])).toBe(3);

    const products = await ws.datera.query(derived.datasetId, 'SELECT count(*) FROM products');
    expect(Number(products.rows[0]?.[0])).toBe(3);
  });

  it('keeps the fact table at full length, with the keys to join on', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);
    const derived = await ws.datera.applyNormalization(DEFAULT_DATASET_ID, proposal, { name: 'Modelled' });

    const rows = await ws.datera.query(derived.datasetId, 'SELECT count(*) FROM sheet');
    expect(Number(rows.rows[0]?.[0])).toBe(9);

    const schema = await ws.datera.describeTable(derived.datasetId, 'sheet');
    const columns = schema.columns.map((c) => c.name);
    expect(columns).toContain('customer_email');
    expect(columns).toContain('product_sku');
    // The attributes moved out — that is what makes this normalization and not a copy.
    expect(columns).not.toContain('customer_name');
    expect(columns).not.toContain('product_category');
  });

  it('records the foreign keys the split created', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);
    const derived = await ws.datera.applyNormalization(DEFAULT_DATASET_ID, proposal, { name: 'Modelled' });

    const links = await ws.datera.listRelationships(derived.datasetId);
    expect(links.map((l) => `${l.fromTable}.${l.fromColumn}->${l.toTable}`)).toEqual(
      expect.arrayContaining(['sheet.customer_email->customers', 'sheet.product_sku->products']),
    );
    expect(links.every((l) => l.state === 'confirmed')).toBe(true);
  });

  it('the normalized result can be joined back to the original numbers', async () => {
    const proposal = await ws.datera.proposeNormalization(sourceId);
    const derived = await ws.datera.applyNormalization(DEFAULT_DATASET_ID, proposal, { name: 'Modelled' });

    const joined = await ws.datera.query(
      derived.datasetId,
      `SELECT c.customer_city, sum(s.revenue_cents) AS revenue
       FROM sheet s JOIN customers c ON c.customer_email = s.customer_email
       GROUP BY c.customer_city ORDER BY revenue DESC`,
    );

    // London: 8900 + 2400 + 12900 = 24200.
    const london = joined.rows.find((r) => r[0] === 'London');
    expect(Number(london?.[1])).toBe(24200);
  });

  describe('enum promotion', () => {
    it('proposes the value set for small-cardinality columns', async () => {
      const proposals = await ws.datera.proposeEnums(sourceId);
      const category = proposals.find((p) => p.column === 'product_category');

      expect(category?.values.sort()).toEqual(['Apparel', 'Gear']);
      expect(category?.distinctValues).toBe(2);
    });

    it('tells the user they can add values that should exist but do not appear', async () => {
      const [proposal] = await ws.datera.proposeEnums(sourceId);
      expect(proposal?.evidence).toMatch(/should exist/i);
    });

    it('does not propose an enum for a column where every row differs', async () => {
      const proposals = await ws.datera.proposeEnums(sourceId);
      expect(proposals.map((p) => p.column)).not.toContain('order_id');
    });
  });
});
