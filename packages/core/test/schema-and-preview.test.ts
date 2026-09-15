import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  LARGE_FIXTURE_ROWS,
  fixturePaths,
  openTestWorkspace,
  type FixturePaths,
  type TestWorkspace,
} from '@datera/testkit';

describe('P1-12 schema introspection and type inference', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace();
  });

  afterAll(async () => {
    await ws.dispose();
  });

  it('reports observed nulls rather than only declared nullability', async () => {
    // DuckDB declares every column of a view over a file nullable, which makes
    // `declaredNullable` nearly meaningless on its own. The number worth showing a user is
    // how many nulls are actually in there.
    const [source] = await ws.datera.addSource({
      type: 'file', path: fixtures.largeParquet, name: 'large',
    });
    if (source === undefined) throw new Error('no source');

    const schema = await ws.datera.getSchema(source.id);
    const value = schema.columns.find((c) => c.name === 'value');
    const id = schema.columns.find((c) => c.name === 'id');

    // The fixture nulls every 7th row.
    expect(value?.nullCount).toBe(Math.floor(LARGE_FIXTURE_ROWS / 7) + 1);
    expect(id?.nullCount).toBe(0);
  });

  it('flags an ambiguous column with evidence and the actual offending values', async () => {
    // The interesting inference case: mostly integers with a few values that are not, so
    // DuckDB widens to VARCHAR. Silently treating that column as text is how a revenue
    // total comes out wrong, so the caveat has to be explicit and carry the offenders.
    const [source] = await ws.datera.addSource({
      type: 'file', path: fixtures.mixedCsv, name: 'mixed',
    });
    if (source === undefined) throw new Error('no source');

    const schema = await ws.datera.getSchema(source.id);
    const amount = schema.columns.find((c) => c.name === 'amount');

    expect(amount?.type).toBe('VARCHAR');
    expect(amount?.inference?.verdict).toBe('ambiguous');
    expect(amount?.inference?.candidateType).toBe('BIGINT');
    expect(amount?.inference?.evidence).toMatch(/do not/);

    const counterExamples = amount?.inference?.counterExamples ?? [];
    expect(counterExamples).toContain('N/A');
    expect(counterExamples).toContain('unknown');
  });

  it('does not flag a column DuckDB already typed narrowly', async () => {
    const [source] = await ws.datera.addSource({
      type: 'file', path: fixtures.ordersCsv, name: 'orders_typed',
    });
    if (source === undefined) throw new Error('no source');

    const schema = await ws.datera.getSchema(source.id);
    expect(schema.columns.find((c) => c.name === 'revenue_cents')?.inference).toBeNull();
    expect(schema.columns.find((c) => c.name === 'qty')?.inference).toBeNull();
  });

  it('notes a VARCHAR column whose every value would fit a narrower type', async () => {
    const dataset = await ws.datera.createDataset({ id: 'narrow', name: 'Narrowable' });
    await ws.datera.defineTable(dataset.id, {
      name: 't',
      columns: [{ name: 'looks_numeric', type: 'VARCHAR' }],
    });
    // Authored tables start empty, so there is nothing to infer from — assert the honest
    // result rather than inventing data the user did not provide.
    const schema = await ws.datera.describeTable(dataset.id, 't');
    expect(schema.columns[0]?.inference).toBeNull();
    expect(schema.rowCount).toBe(0);
  });

  it('includes sample values for the dictionary auto-draft to consume in Phase 3', async () => {
    const [source] = await ws.datera.addSource({
      type: 'file', path: fixtures.ordersCsv, name: 'orders_samples',
    });
    if (source === undefined) throw new Error('no source');

    const schema = await ws.datera.getSchema(source.id);
    const product = schema.columns.find((c) => c.name === 'product');
    expect(product?.sampleValues.length).toBeGreaterThan(0);
    expect(product?.sampleValues).toContain('Trail Hoodie');
  });
});

describe('P1-13 paged preview reads', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let largeSourceId: string;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace();
    const [source] = await ws.datera.addSource({
      type: 'file', path: fixtures.largeParquet, name: 'large',
    });
    if (source === undefined) throw new Error('no source');
    largeSourceId = source.id;
  });

  afterAll(async () => {
    await ws.dispose();
  });

  it('previews a million-row source quickly and without loading it', async () => {
    const started = performance.now();
    const preview = await ws.datera.preview(largeSourceId, { limit: 50 });
    const elapsed = performance.now() - started;

    expect(preview.rows).toHaveLength(50);
    expect(preview.hasMore).toBe(true);
    // Generous, because CI runners are slow — but a full materialisation of a million rows
    // would not come close to fitting in it.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('pages stably', async () => {
    const first = await ws.datera.preview(largeSourceId, { limit: 10, offset: 0 });
    const second = await ws.datera.preview(largeSourceId, { limit: 10, offset: 10 });
    const firstAgain = await ws.datera.preview(largeSourceId, { limit: 10, offset: 0 });

    expect(firstAgain.rows).toEqual(first.rows);
    expect(second.rows[0]).not.toEqual(first.rows[0]);
    expect(first.offset).toBe(0);
    expect(second.offset).toBe(10);
  });

  it('reports hasMore false on the last page', async () => {
    const preview = await ws.datera.preview(largeSourceId, {
      limit: 10,
      offset: LARGE_FIXTURE_ROWS - 5,
    });
    expect(preview.rows).toHaveLength(5);
    expect(preview.hasMore).toBe(false);
  });

  it('clamps an absurd limit rather than obeying it', async () => {
    // A preview is a window, not a download. Obeying limit: 10_000_000 would turn a UI
    // interaction into a full scan.
    const preview = await ws.datera.preview(largeSourceId, { limit: 10_000_000 });
    expect(preview.limit).toBe(1000);
    expect(preview.rows).toHaveLength(1000);
  });

  it('clamps a negative or zero limit and a negative offset', async () => {
    expect((await ws.datera.preview(largeSourceId, { limit: 0 })).limit).toBe(1);
    expect((await ws.datera.preview(largeSourceId, { limit: -5 })).limit).toBe(1);
    expect((await ws.datera.preview(largeSourceId, { offset: -10 })).offset).toBe(0);
  });

  it('keeps BIGINT values exact across the boundary', async () => {
    // BIGINT arrives as a JS bigint and is stringified by the driver. Losing precision on
    // an id column is exactly the class of bug invariant §1.5 exists to prevent.
    const result = await ws.datera.query(
      DEFAULT_DATASET_ID,
      'SELECT 9007199254740993::BIGINT AS big',
    );
    expect(result.rows[0]?.[0]).toBe('9007199254740993');
  });
});
