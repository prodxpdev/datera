import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFile } from 'node:fs/promises';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  describeDifferences,
  diffDatabaseFingerprints,
  fingerprintAttachedDatabase,
  fingerprintFile,
  fixturePaths,
  openTestWorkspace,
  queryThrough,
  withUnchangedFiles,
  type FixturePaths,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * P1-14 / acceptance §12.1 — connecting a source never modifies it.
 *
 * This is the assertion Phase 1 is judged on. Invariant §1.1 is the promise the whole
 * product rests on, so it is checked across *every* supported source kind rather than on
 * a representative one, and through the full lifecycle a real user puts a file through:
 * connect, introspect, preview, and query — including a join and an aggregate.
 */
describe('P1-14 sources are byte-identical after connect + query', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeAll(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace();
  });

  afterAll(async () => {
    await ws.dispose();
  });

  const fileCases = [
    { label: 'CSV', get: (f: FixturePaths) => f.ordersCsv, name: 'orders' },
    { label: 'CSV with quoted commas', get: (f: FixturePaths) => f.quotedCsv, name: 'quoted' },
    { label: 'TSV', get: (f: FixturePaths) => f.ordersTsv, name: 'orders_tsv' },
    { label: 'NDJSON', get: (f: FixturePaths) => f.notesNdjson, name: 'notes' },
    { label: 'nested JSON', get: (f: FixturePaths) => f.nestedJson, name: 'nested' },
    { label: 'Parquet', get: (f: FixturePaths) => f.ordersParquet, name: 'orders_parquet' },
    { label: 'XLSX', get: (f: FixturePaths) => f.workbookXlsx, name: 'workbook' },
  ] as const;

  it.each(fileCases)('$label is unchanged by connect, introspect, preview and query', async ({ get, name }) => {
    const path = get(fixtures);

    const { result, differences } = await withUnchangedFiles([path], async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path, name });
      if (source === undefined) throw new Error('no source created');

      await ws.datera.getSchema(source.id);
      await ws.datera.preview(source.id, { limit: 10 });
      await ws.datera.query(DEFAULT_DATASET_ID, `SELECT count(*) FROM "${source.name}"`);
      return source;
    });

    expect(describeDifferences(differences)).toBe('');
    expect(result.origin).toBe(path);
  });

  it('a SQLite file is unchanged by attach, introspect and query', async () => {
    const path = fixtures.customersSqlite;

    const { differences } = await withUnchangedFiles([path], async () => {
      const sources = await ws.datera.addSource({ type: 'sqlite', path, namePrefix: 'sq_' });
      for (const source of sources) {
        await ws.datera.getSchema(source.id);
        await ws.datera.preview(source.id, { limit: 5 });
      }
      await ws.datera.query(
        DEFAULT_DATASET_ID,
        'SELECT c.plan, count(*) FROM sq_customers c GROUP BY c.plan',
      );
    });

    expect(describeDifferences(differences)).toBe('');
  });

  it('an aggregate and a join across sources leave every file untouched', async () => {
    // The interesting case: a query that actually reads several sources at once, which is
    // where a careless implementation would materialise or rewrite something.
    const watched = [fixtures.ordersCsv, fixtures.customersSqlite, fixtures.ordersParquet];

    const { result, differences } = await withUnchangedFiles(watched, async () =>
      ws.datera.query(
        DEFAULT_DATASET_ID,
        `SELECT c.plan, count(*) AS orders, sum(o.revenue_cents) / 100.0 AS revenue
         FROM orders o
         JOIN sq_customers c ON c.id = o.order_id
         GROUP BY c.plan
         ORDER BY revenue DESC`,
      ),
    );

    expect(describeDifferences(differences)).toBe('');
    expect(result.statementKinds).toEqual(['SELECT']);
  });

  it('an attached SQLite database is unchanged, measured through the connection', async () => {
    // The database half of §12.1. A live database has no file to hash, so "unchanged" is
    // established from table list, row counts and per-table checksums — see db-identity.ts
    // for an honest statement of what that does and does not catch.
    const query = queryThrough(ws.datera, DEFAULT_DATASET_ID);

    const alias = 'customers';
    const before = await fingerprintAttachedDatabase(query, alias);
    expect(before.tables.length).toBeGreaterThan(0);

    await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT * FROM sq_customers');
    await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM sq_plans');

    const after = await fingerprintAttachedDatabase(query, alias);
    expect(diffDatabaseFingerprints(before, after)).toEqual([]);
  });

  it('refuses a write to an attached database, and the database is unchanged afterwards', async () => {
    const query = queryThrough(ws.datera, DEFAULT_DATASET_ID);
    const before = await fingerprintAttachedDatabase(query, 'customers');

    await expect(
      ws.datera.query(DEFAULT_DATASET_ID, `INSERT INTO sq_customers VALUES ('x','x','x',1)`),
    ).rejects.toMatchObject({ code: 'READ_ONLY_VIOLATION' });

    const after = await fingerprintAttachedDatabase(query, 'customers');
    expect(diffDatabaseFingerprints(before, after)).toEqual([]);
  });

  it('removing a source drops only Datera’s view, never the file', async () => {
    const path = fixtures.mixedCsv;
    const { differences } = await withUnchangedFiles([path], async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path, name: 'disposable' });
      if (source === undefined) throw new Error('no source created');
      await ws.datera.removeSource(source.id);
    });

    expect(describeDifferences(differences)).toBe('');
  });

  /**
   * The negative control.
   *
   * Every assertion above claims "nothing changed". None of them mean anything unless the
   * harness can actually detect a change, so here one is made deliberately. If this test
   * ever passes without the mutation, the entire suite above is decorative.
   */
  describe('negative control — the harness must be able to fail', () => {
    it('detects a deliberate modification to a watched file', async () => {
      const path = fixtures.raggedCsv;

      const { differences } = await withUnchangedFiles([path], async () => {
        await appendFile(path, '\n4,Deliberate,Mutation\n', 'utf8');
      });

      expect(differences.length).toBeGreaterThan(0);
      expect(differences.map((d) => d.field)).toContain('sha256');
      expect(differences.map((d) => d.field)).toContain('size');
    });

    it('detects a touch that rewrites identical bytes', async () => {
      // Content-only checking would miss this, and it is still a write. A tool that
      // rewrites your file with identical bytes is not read-only.
      const path = fixtures.quotedCsv;
      const before = await fingerprintFile(path);

      const { readFile, writeFile } = await import('node:fs/promises');
      const bytes = await readFile(path);
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(path, bytes);

      const after = await fingerprintFile(path);
      expect(after.sha256).toBe(before.sha256);
      expect(after.mtimeMs).not.toBe(before.mtimeMs);
    });
  });
});
