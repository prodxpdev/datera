import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  describeDifferences,
  fixturePaths,
  openTestWorkspace,
  testPorts,
  withUnchangedFiles,
  type FixturePaths,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * Phase 5 — copy-on-write, versions, normalize, and portability.
 *
 * Spec §3 makes versioning, non-destructive editing and backup **one mechanism**, not
 * three features: the source is immutable, edits land on a copy, and a version is a copy
 * at a point in time. These tests hold that line, and §12.6's byte-identity assertion runs
 * through every operation that could plausibly touch a source.
 */
describe('§12.6 copy-on-write', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('derives a dataset as real tables, leaving the source untouched', async () => {
    const { result, differences } = await withUnchangedFiles([fixtures.ordersCsv], async () =>
      ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' }),
    );

    expect(describeDifferences(differences)).toBe('');
    expect(result.datasetId).not.toBe(DEFAULT_DATASET_ID);

    // The copy holds the same data, and it is a table now — something that can be edited
    // without the original being at risk.
    const copied = await ws.datera.query(result.datasetId, 'SELECT count(*) FROM orders');
    expect(Number(copied.rows[0]?.[0])).toBe(6);
  });

  it('marks the derived dataset as derived, and records where it came from', async () => {
    const derived = await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' });
    const dataset = await ws.datera.getDataset(derived.datasetId);

    expect(dataset.derivedFrom).toBe(DEFAULT_DATASET_ID);
    expect(dataset.kind).toBe('derived');
  });

  it('keeps the derived copy isolated from the original dataset', async () => {
    const derived = await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' });

    // §12.4 applies to derived datasets exactly as it does to any other.
    await expect(
      ws.datera.query(DEFAULT_DATASET_ID, `SELECT * FROM ${(await ws.datera.getDataset(derived.datasetId)).schemaName}.orders`),
    ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
  });
});

describe('§3 versions are copies at a point in time', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let derivedId: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    derivedId = (await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' })).datasetId;
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('snapshots a dataset and lists the version', async () => {
    const version = await ws.datera.saveVersion(derivedId, 'before changes');

    const versions = await ws.datera.listVersions(derivedId);
    expect(versions.map((v) => v.id)).toContain(version.id);
    expect(versions[0]?.label).toBe('before changes');
  });

  it('a version is unaffected by later changes to the dataset', async () => {
    await ws.datera.saveVersion(derivedId, 'v1');
    await ws.datera.defineTable(derivedId, { name: 'extra', columns: [{ name: 'a', type: 'BIGINT' }] });

    const v1Tables = await ws.datera.listVersionTables((await ws.datera.listVersions(derivedId))[0]!.id);
    expect(v1Tables).not.toContain('extra');
    expect(await ws.datera.listTables(derivedId)).toContain('extra');
  });

  it('diffs two versions, computed in code (§1.5)', async () => {
    const v1 = await ws.datera.saveVersion(derivedId, 'v1');
    await ws.datera.defineTable(derivedId, {
      name: 'products',
      columns: [{ name: 'sku', type: 'VARCHAR' }],
    });
    const v2 = await ws.datera.saveVersion(derivedId, 'v2');

    const diff = await ws.datera.diffVersions(v1.id, v2.id);

    expect(diff.tablesAdded).toContain('products');
    expect(diff.tablesRemoved).toEqual([]);
    expect(diff.rowCountChanges.find((c) => c.table === 'orders')?.before).toBe(6);
  });

  it('reports a row-count change between versions', async () => {
    const v1 = await ws.datera.saveVersion(derivedId, 'v1');
    // A structural change that alters the data: rebuild the table with fewer rows.
    await ws.datera.replaceTableForTesting(derivedId, 'orders', 'SELECT * FROM orders WHERE refunded = false');
    const v2 = await ws.datera.saveVersion(derivedId, 'v2');

    const diff = await ws.datera.diffVersions(v1.id, v2.id);
    const change = diff.rowCountChanges.find((c) => c.table === 'orders');
    expect(change?.before).toBe(6);
    expect(change?.after).toBe(5);
  });

  it('reports a column change between versions', async () => {
    const v1 = await ws.datera.saveVersion(derivedId, 'v1');
    await ws.datera.replaceTableForTesting(derivedId, 'orders', 'SELECT order_id, product FROM orders');
    const v2 = await ws.datera.saveVersion(derivedId, 'v2');

    const diff = await ws.datera.diffVersions(v1.id, v2.id);
    const change = diff.columnChanges.find((c) => c.table === 'orders');
    expect(change?.removed).toEqual(expect.arrayContaining(['revenue_cents', 'qty']));
  });
});

describe('§12.11 portability — delete Datera and your artifact still runs', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let exportDir: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    exportDir = await mkdtemp(join(tmpdir(), 'datera-export-'));
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterEach(async () => {
    await ws.dispose();
    await rm(exportDir, { recursive: true, force: true });
  });

  it('exports data, schema, dictionary and dataset definition in open formats', async () => {
    const draft = await ws.datera.draftDictionary((await ws.datera.listSources())[0]!.id);
    await ws.datera.confirmColumn((await ws.datera.listSources())[0]!.id, {
      ...draft.columns.find((c) => c.column === 'revenue_cents')!,
      state: 'confirmed',
    });

    const result = await ws.datera.exportDataset(DEFAULT_DATASET_ID, exportDir, { format: 'parquet' });

    expect(result.files.some((f) => f.endsWith('.parquet'))).toBe(true);
    expect(result.files.some((f) => f.endsWith('datera-export.json'))).toBe(true);
    // Open formats only: nothing here should require Datera to read.
    expect(result.files.every((f) => /\.(parquet|csv|json|sql)$/.test(f))).toBe(true);
  });

  it('round-trips losslessly into a clean instance', async () => {
    const sourceId = (await ws.datera.listSources())[0]!.id;
    const draft = await ws.datera.draftDictionary(sourceId);
    await ws.datera.confirmColumn(sourceId, {
      ...draft.columns.find((c) => c.column === 'revenue_cents')!,
      meaning: 'Revenue in cents.',
      aliases: ['sales'],
      state: 'confirmed',
    });
    await ws.datera.confirmEntity(sourceId, { ...draft.entity, state: 'confirmed' });

    await ws.datera.exportDataset(DEFAULT_DATASET_ID, exportDir, { format: 'parquet' });

    // A genuinely separate instance, with its own workspace directory.
    const clean = await openTestWorkspace({ ports: testPorts() });
    try {
      const imported = await clean.datera.importDataset(exportDir);

      expect(await clean.datera.listTables(imported.datasetId)).toContain('orders');

      const rows = await clean.datera.query(imported.datasetId, 'SELECT count(*) FROM orders');
      expect(Number(rows.rows[0]?.[0])).toBe(6);

      // Types survive — a round trip that turned BIGINT into VARCHAR would be lossy.
      const schema = await clean.datera.describeTable(imported.datasetId, 'orders');
      expect(schema.columns.find((c) => c.name === 'revenue_cents')?.type).toBe('BIGINT');

      // And the semantic layer survives, which is the part a naive export drops.
      const importedSource = (await clean.datera.listSources()).find((s) => s.name === 'orders');
      const dictionary = await clean.datera.getDictionary(importedSource!.id);
      const revenue = dictionary.columns.find((c) => c.column === 'revenue_cents');
      expect(revenue?.state).toBe('confirmed');
      expect(revenue?.aliases).toContain('sales');
      expect(dictionary.entity.state).toBe('confirmed');
    } finally {
      await clean.dispose();
    }
  });

  it('carries confirmed relationships across the round trip', async () => {
    // §12.11 names relationships explicitly, and the exporter has always written them —
    // but nothing asserted they came back. A round trip that silently dropped the joins
    // would still pass every other assertion here while leaving the imported dataset
    // unable to answer the questions the original could.
    await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'support_notes' });

    const [proposal] = await ws.datera.detectRelationships(DEFAULT_DATASET_ID);
    const confirmed = await ws.datera.confirmRelationship(DEFAULT_DATASET_ID, proposal!);

    await ws.datera.exportDataset(DEFAULT_DATASET_ID, exportDir, { format: 'parquet' });

    const clean = await openTestWorkspace({ ports: testPorts() });
    try {
      const imported = await clean.datera.importDataset(exportDir);
      const links = await clean.datera.listRelationships(imported.datasetId);

      expect(links).toHaveLength(1);
      expect(links[0]?.fromTable).toBe(confirmed.fromTable);
      expect(links[0]?.fromColumn).toBe(confirmed.fromColumn);
      expect(links[0]?.toTable).toBe(confirmed.toTable);
      expect(links[0]?.toColumn).toBe(confirmed.toColumn);

      // And it is usable, not merely recorded: the join the relationship describes runs.
      const joined = await clean.datera.query(
        imported.datasetId,
        `SELECT count(*) FROM orders o JOIN support_notes n ON o.${confirmed.toColumn} = n.${confirmed.fromColumn}`,
      );
      expect(Number(joined.rows[0]?.[0])).toBeGreaterThan(0);
    } finally {
      await clean.dispose();
    }
  });

  it('exports CSV when asked, for tools that cannot read Parquet', async () => {
    const result = await ws.datera.exportDataset(DEFAULT_DATASET_ID, exportDir, { format: 'csv' });
    expect(result.files.some((f) => f.endsWith('.csv'))).toBe(true);
  });

  it('never modifies the source while exporting', async () => {
    const { differences } = await withUnchangedFiles([fixtures.ordersCsv], async () =>
      ws.datera.exportDataset(DEFAULT_DATASET_ID, exportDir, { format: 'parquet' }),
    );
    expect(describeDifferences(differences)).toBe('');
  });
});
