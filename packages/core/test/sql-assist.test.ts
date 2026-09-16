import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID, completionsAt, referencedTables, starterSql } from '@datera/core';
import { fixturePaths, openTestWorkspace, testPorts, type FixturePaths, type TestWorkspace } from '@datera/testkit';

/**
 * SQL editor assistance — deterministic, and deliberately not a model.
 *
 * Completing a column name is a lookup, not a judgement: the schema is right there. Using
 * a model for it would be slower, cost money, occasionally wrong, and — on the local tier
 * — take 45 seconds to suggest a word the user already half-typed.
 */
describe('schema graph', () => {
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

  it('describes every table with its columns and row count', async () => {
    const graph = await ws.datera.schemaGraph(DEFAULT_DATASET_ID);

    expect(graph.tables.map((t) => t.name).sort()).toEqual(['orders', 'support_notes']);

    const orders = graph.tables.find((t) => t.name === 'orders');
    expect(orders?.rowCount).toBe(6);
    expect(orders?.columns.map((c) => c.name)).toContain('revenue_cents');
    expect(orders?.columns.find((c) => c.name === 'revenue_cents')?.type).toBe('BIGINT');
  });

  it('marks the columns a relationship connects', async () => {
    const [link] = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
    await ws.datera.confirmRelationship(DEFAULT_DATASET_ID, link!);

    const graph = await ws.datera.schemaGraph(DEFAULT_DATASET_ID);

    expect(graph.relationships).toHaveLength(1);
    expect(graph.relationships[0]?.fromColumn).toBe('order_id');

    const notes = graph.tables.find((t) => t.name === 'support_notes');
    expect(notes?.columns.find((c) => c.name === 'order_id')?.isKey).toBe(true);
  });

  it('carries the dictionary meaning when one is confirmed', async () => {
    const source = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;
    const draft = await ws.datera.draftDictionary(source.id);
    await ws.datera.confirmColumn(source.id, {
      ...draft.columns.find((c) => c.column === 'revenue_cents')!,
      state: 'confirmed',
    });

    const graph = await ws.datera.schemaGraph(DEFAULT_DATASET_ID);
    const column = graph.tables
      .find((t) => t.name === 'orders')
      ?.columns.find((c) => c.name === 'revenue_cents');

    expect(column?.meaning).toMatch(/cents|minor/i);
  });

  it('omits a column the user marked sensitive', async () => {
    const source = (await ws.datera.listSources()).find((s) => s.name === 'orders')!;
    const draft = await ws.datera.draftDictionary(source.id);
    await ws.datera.confirmColumn(source.id, {
      ...draft.columns.find((c) => c.column === 'product')!,
      sensitivity: 'hidden',
      state: 'confirmed',
    });

    const graph = await ws.datera.schemaGraph(DEFAULT_DATASET_ID);
    const orders = graph.tables.find((t) => t.name === 'orders');

    // Consistent with the model context: a column withheld from a model should not be
    // advertised in a picker either.
    expect(orders?.columns.map((c) => c.name)).not.toContain('product');
    expect(orders?.hiddenColumns).toBe(1);
  });

  it('stays inside the dataset', async () => {
    await ws.datera.createDataset({ id: 'other', name: 'Other' });
    const graph = await ws.datera.schemaGraph('other');
    expect(graph.tables).toEqual([]);
  });
});

describe('starter SQL comes from the real schema', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('names a table that actually exists', async () => {
    // The bug this replaces: the editor opened with `SELECT * FROM orders LIMIT 20` as a
    // literal, so on any workspace without a table called `orders` the first thing a user
    // saw was a catalog error.
    await ws.datera.addSource({ type: 'file', path: fixtures.flatSheetCsv, name: 'sheet' });

    const graph = await ws.datera.schemaGraph(DEFAULT_DATASET_ID);
    const sql = starterSql(graph);

    expect(sql).toContain('sheet');
    expect(sql).not.toContain('orders');

    const result = await ws.datera.query(DEFAULT_DATASET_ID, sql.replace(/;\s*$/, ''));
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('says so plainly when the dataset is empty', async () => {
    const graph = await ws.datera.schemaGraph(DEFAULT_DATASET_ID);
    expect(starterSql(graph)).toMatch(/--/);
  });
});

describe('completions', () => {
  const graph = {
    datasetId: 'd',
    tables: [
      {
        name: 'orders',
        rowCount: 6,
        hiddenColumns: 0,
        columns: [
          { name: 'order_id', type: 'VARCHAR', isKey: true, nullCount: 0, meaning: '' },
          { name: 'product', type: 'VARCHAR', isKey: false, nullCount: 0, meaning: '' },
          { name: 'revenue_cents', type: 'BIGINT', isKey: false, nullCount: 0, meaning: 'Money in cents' },
        ],
      },
      {
        name: 'support_notes',
        rowCount: 3,
        hiddenColumns: 0,
        columns: [
          { name: 'order_id', type: 'VARCHAR', isKey: true, nullCount: 0, meaning: '' },
          { name: 'note', type: 'VARCHAR', isKey: false, nullCount: 0, meaning: '' },
        ],
      },
    ],
    relationships: [
      { fromTable: 'support_notes', fromColumn: 'order_id', toTable: 'orders', toColumn: 'order_id' },
    ],
  };

  const at = (sql: string): ReturnType<typeof completionsAt> => completionsAt(graph, sql, sql.length);
  /** ⌃Space — the user asked for the full list, so restraint does not apply. */
  const explicitly = (sql: string, cursor = sql.length): ReturnType<typeof completionsAt> =>
    completionsAt(graph, sql, cursor, { trigger: 'explicit' });

  it('suggests tables after FROM', () => {
    const result = at('SELECT * FROM ');
    expect(result.items.map((i) => i.label)).toEqual(['orders', 'support_notes']);
    expect(result.items[0]?.kind).toBe('table');
  });

  it('suggests tables after JOIN', () => {
    expect(at('SELECT * FROM orders JOIN ').items.map((i) => i.label)).toContain('support_notes');
  });

  it('filters by what has been typed', () => {
    const result = at('SELECT * FROM sup');
    expect(result.items.map((i) => i.label)).toEqual(['support_notes']);
    expect(result.replacing).toBe('sup');
  });

  it('suggests columns of the tables already in the query', () => {
    const result = at('SELECT  FROM orders');
    const labels = explicitly('SELECT  FROM orders', 7).items.map((i) => i.label);
    expect(labels).toContain('product');
    expect(labels).toContain('revenue_cents');
    // Not columns of a table the query has not mentioned.
    expect(labels).not.toContain('note');
    void result;
  });

  it('suggests columns of every joined table', () => {
    const sql = 'SELECT  FROM orders JOIN support_notes ON 1=1';
    const labels = explicitly(sql, 7).items.map((i) => i.label);
    expect(labels).toContain('product');
    expect(labels).toContain('note');
  });

  it('suggests only that table’s columns after a dot', () => {
    const result = at('SELECT * FROM orders WHERE orders.');
    expect(result.items.map((i) => i.label)).toEqual(['order_id', 'product', 'revenue_cents']);
    expect(result.items.every((i) => i.kind === 'column')).toBe(true);
  });

  it('resolves an alias before the dot', () => {
    const result = at('SELECT * FROM orders o WHERE o.');
    expect(result.items.map((i) => i.label)).toContain('revenue_cents');
    expect(result.items.map((i) => i.label)).not.toContain('note');
  });

  it('carries the dictionary meaning into the suggestion', () => {
    const result = at('SELECT * FROM orders WHERE orders.rev');
    expect(result.items[0]?.detail).toContain('cents');
  });

  it('suggests keywords at the start', () => {
    expect(at('SEL').items.map((i) => i.label)).toContain('SELECT');
  });

  it('suggests a join condition after ON', () => {
    const result = at('SELECT * FROM orders JOIN support_notes ON ');
    // The confirmed relationship is the thing worth offering here.
    expect(result.items.map((i) => i.label).join(' ')).toContain('support_notes.order_id');
  });

  it('returns nothing rather than noise mid-word in a string literal', () => {
    const result = at(`SELECT * FROM orders WHERE product = 'Trail Ho`);
    expect(result.items).toEqual([]);
  });

  // ---- restraint -----------------------------------------------------------
  //
  // Typing `SELECT ` used to open a scrolling list of all thirty keywords. A picker that
  // appears uninvited and covers the editor is worse than no picker: it hides the query
  // being written, and its first highlighted entry is one Tab away from being inserted.

  it('offers nothing mid-statement until something has been typed', () => {
    expect(at('SELECT ').items).toEqual([]);
    expect(at('SELECT * FROM orders WHERE ').items).toEqual([]);
  });

  it('still offers everything when the user explicitly asks', () => {
    // ⌃Space is a request. Restraint applies to appearing uninvited, not to being useful.
    expect(explicitly('SELECT ').items.length).toBeGreaterThan(0);
  });

  it('offers a column as soon as one character narrows it', () => {
    const labels = at('SELECT * FROM orders WHERE p').items.map((i) => i.label);
    expect(labels).toContain('product');
  });

  it('holds keywords back until two characters, since one matches too many', () => {
    const one = at('SELECT * FROM orders WHERE s').items;
    expect(one.every((i) => i.kind !== 'keyword')).toBe(true);

    const two = at('SELECT * FROM orders WHERE su').items.map((i) => i.label);
    expect(two).toContain('SUM');
  });

  it('still opens with no prefix where the position asks a specific question', () => {
    // After FROM there is exactly one kind of answer and few of them, so appearing is
    // helpful rather than noisy. Same after a dot, and after ON.
    expect(at('SELECT * FROM ').items.length).toBeGreaterThan(0);
    expect(at('SELECT * FROM orders WHERE orders.').items.length).toBeGreaterThan(0);
    expect(at('SELECT * FROM orders JOIN support_notes ON ').items.length).toBeGreaterThan(0);
  });

  it('never returns more than fits on screen', () => {
    // The box showed ten and scrolled; a list you have to scroll is a list you read
    // instead of typing past.
    expect(explicitly('SELECT ').items.length).toBeLessThanOrEqual(12);
  });

  it('puts columns before keywords, because that is what the schema knows', () => {
    const kinds = at('SELECT * FROM orders WHERE pr').items.map((i) => i.kind);
    if (kinds.includes('keyword') && kinds.includes('column')) {
      expect(kinds.indexOf('column')).toBeLessThan(kinds.indexOf('keyword'));
    }
  });

  it('is deterministic', () => {
    expect(at('SELECT * FROM o')).toEqual(at('SELECT * FROM o'));
  });
});

describe('referenced tables, for live highlighting', () => {
  const names = ['orders', 'support_notes', 'customers'];

  it('finds tables in a complete query', () => {
    expect(referencedTables('SELECT * FROM orders JOIN support_notes ON 1=1', names).sort())
      .toEqual(['orders', 'support_notes']);
  });

  it('finds a table in a half-typed query', () => {
    // The point: highlighting has to work while someone is still typing, so this is a
    // tolerant scan rather than the AST walk the dataset guard uses.
    expect(referencedTables('SELECT * FROM orders WHERE', names)).toEqual(['orders']);
  });

  it('ignores a name that only appears in a string', () => {
    expect(referencedTables(`SELECT * FROM orders WHERE product = 'customers'`, names)).toEqual(['orders']);
  });

  it('ignores a name that is part of a longer identifier', () => {
    expect(referencedTables('SELECT * FROM orders_archive', names)).toEqual([]);
  });

  it('returns nothing for an empty query', () => {
    expect(referencedTables('', names)).toEqual([]);
  });
});
