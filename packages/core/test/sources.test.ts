import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DATASET_ID, inferFileKind } from '@datera/core';
import { fixturePaths, openTestWorkspace, type FixturePaths, type TestWorkspace } from '@datera/testkit';

/** P1-07 / P1-08 / P1-09 / P1-10 — connecting each supported source kind, read-only. */
describe('connect and ingest', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace();
  });

  afterEach(async () => {
    await ws.dispose();
  });

  describe('P1-08 flat files', () => {
    it('reads a CSV and reports the sniffed parse settings as evidence', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv });
      if (source === undefined) throw new Error('no source');

      expect(source.kind).toBe('csv');
      expect(source.name).toBe('orders');
      expect(source.detection.method).toBe('DuckDB CSV sniffer');

      // The evidence is the point: "how did it parse my file" is a transparency question.
      expect(source.detection.settings['Delimiter']).toBe(',');
      expect(source.detection.settings['HasHeader']).toBe('true');
      // The fully-explicit call, so a user can reproduce the exact parse by hand.
      expect(source.detection.settings['Prompt']).toContain('read_csv');

      const schema = await ws.datera.getSchema(source.id);
      expect(schema.rowCount).toBe(6);
      expect(schema.columns.map((c) => c.name)).toEqual([
        'order_id', 'product', 'revenue_cents', 'qty', 'created_at', 'refunded',
      ]);
      expect(schema.columns.find((c) => c.name === 'revenue_cents')?.type).toBe('BIGINT');
      expect(schema.columns.find((c) => c.name === 'refunded')?.type).toBe('BOOLEAN');
    });

    it('handles quoted commas, embedded quotes and embedded newlines', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.quotedCsv });
      if (source === undefined) throw new Error('no source');

      const preview = await ws.datera.preview(source.id);
      expect(preview.rows).toHaveLength(3);
      // The comma stayed inside the field rather than splitting it.
      expect(preview.rows[0]?.[1]).toBe('Hoodie, blue');
      expect(preview.rows[1]?.[1]).toBe('A 12" ruler');
      expect(String(preview.rows[2]?.[1])).toContain('\n');
    });

    it('warns when a ragged CSV makes the sniffer fall back to a bogus delimiter', async () => {
      // A row with more fields than the header makes DuckDB abandon the comma and read the
      // whole line into a single VARCHAR column. Nothing errors and the data is nonsense —
      // the exact failure mode a transparency tool must surface rather than pass over.
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.raggedCsv });
      if (source === undefined) throw new Error('no source');

      const schema = await ws.datera.getSchema(source.id);
      expect(schema.columns).toHaveLength(1);

      expect(source.detection.warnings ?? []).toHaveLength(1);
      expect(source.detection.warnings?.[0]).toMatch(/single column/i);
      expect(source.detection.warnings?.[0]).toMatch(/delimiter/i);
    });

    it('does not warn about a well-formed CSV', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv });
      expect(source?.detection.warnings ?? []).toHaveLength(0);
    });

    it('reads a TSV', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersTsv });
      if (source === undefined) throw new Error('no source');
      expect(source.kind).toBe('tsv');
      expect(source.detection.settings['Delimiter']).toBe('\t');
      expect((await ws.datera.getSchema(source.id)).rowCount).toBe(6);
    });

    it('reads newline-delimited JSON', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson });
      if (source === undefined) throw new Error('no source');
      const schema = await ws.datera.getSchema(source.id);
      expect(schema.rowCount).toBe(3);
      expect(schema.columns.map((c) => c.name)).toEqual(['order_id', 'note', 'channel']);
    });

    it('reads nested JSON, preserving structure in the type', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.nestedJson });
      if (source === undefined) throw new Error('no source');
      const schema = await ws.datera.getSchema(source.id);
      expect(schema.rowCount).toBe(2);
      expect(schema.columns.find((c) => c.name === 'customer')?.type).toContain('STRUCT');
    });

    it('reads Parquet, taking the schema from the footer', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersParquet });
      if (source === undefined) throw new Error('no source');
      expect(source.detection.method).toBe('read_parquet');
      const schema = await ws.datera.getSchema(source.id);
      expect(schema.rowCount).toBe(6);
      expect(schema.columns.find((c) => c.name === 'revenue_cents')?.type).toBe('BIGINT');
    });
  });

  describe('P1-09 Excel', () => {
    it('reads the default sheet of a workbook', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.workbookXlsx });
      if (source === undefined) throw new Error('no source');

      expect(source.kind).toBe('xlsx');
      const schema = await ws.datera.getSchema(source.id);
      expect(schema.columns.map((c) => c.name)).toEqual(['order_id', 'product', 'revenue_cents']);
      expect(schema.rowCount).toBe(3);
    });

    it('addresses a named sheet as its own source', async () => {
      const [orders] = await ws.datera.addSource({
        type: 'file', path: fixtures.workbookXlsx, name: 'wb_orders', sheet: 'Orders',
      });
      const [refunds] = await ws.datera.addSource({
        type: 'file', path: fixtures.workbookXlsx, name: 'wb_refunds', sheet: 'Refunds',
      });
      if (orders === undefined || refunds === undefined) throw new Error('no source');

      expect((await ws.datera.getSchema(orders.id)).rowCount).toBe(3);
      const refundSchema = await ws.datera.getSchema(refunds.id);
      expect(refundSchema.rowCount).toBe(1);
      expect(refundSchema.columns.map((c) => c.name)).toEqual(['order_id', 'reason']);
    });

    it('refuses .xls with the fix in the message (decision D-07)', () => {
      expect(() => inferFileKind('/tmp/legacy.xls')).toThrowError(/re-save the file as \.xlsx/i);
    });
  });

  describe('P1-10 SQLite', () => {
    it('attaches read-only and registers every table as a source', async () => {
      const sources = await ws.datera.addSource({ type: 'sqlite', path: fixtures.customersSqlite });
      expect(sources.map((s) => s.name).sort()).toEqual(['customers', 'plans']);
      expect(sources.every((s) => s.kind === 'sqlite')).toBe(true);
      expect(sources[0]?.detection.method).toBe('sqlite ATTACH (READ_ONLY)');
      expect(sources[0]?.detection.settings['readOnly']).toContain('true');

      const customers = sources.find((s) => s.name === 'customers');
      if (customers === undefined) throw new Error('no customers source');
      const schema = await ws.datera.getSchema(customers.id);
      expect(schema.rowCount).toBe(3);
      expect(schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'plan', 'ltv_cents']);
    });

    it('can select a subset of tables', async () => {
      const sources = await ws.datera.addSource({
        type: 'sqlite', path: fixtures.customersSqlite, tables: ['plans'],
      });
      expect(sources.map((s) => s.name)).toEqual(['plans']);
    });

    it('reports a clear error when the requested table does not exist', async () => {
      await expect(
        ws.datera.addSource({ type: 'sqlite', path: fixtures.customersSqlite, tables: ['nope'] }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    });
  });

  describe('P1-07 catalog and availability', () => {
    it('refuses an unrecognised extension with the supported list', async () => {
      await expect(
        ws.datera.addSource({ type: 'file', path: '/tmp/whatever.docx' }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    });

    it('refuses Markdown, which is not a v1 source format (decision D-02)', () => {
      expect(() => inferFileKind('/tmp/notes.md')).toThrowError(/not a v1 source format/i);
    });

    it('reports a missing file rather than registering it', async () => {
      await expect(
        ws.datera.addSource({ type: 'file', path: join(fixtures.root, 'absent.csv') }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    });

    it('disambiguates a duplicate name instead of overwriting', async () => {
      const [first] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv });
      const [second] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv });
      expect(first?.name).toBe('orders');
      expect(second?.name).toBe('orders_2');
    });

    it('survives a restart, and re-attaches databases', async () => {
      await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
      await ws.datera.addSource({ type: 'sqlite', path: fixtures.customersSqlite });

      ws = await ws.reopen();

      const sources = await ws.datera.listSources();
      expect(sources.map((s) => s.name).sort()).toEqual(['customers', 'orders', 'plans']);
      expect(sources.every((s) => s.status.availability === 'available')).toBe(true);

      // Re-attachment actually worked, rather than the catalog merely remembering.
      const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM customers');
      expect(Number(result.rows[0]?.[0])).toBe(3);
    });

    it('reports a moved file as unavailable with a reason, rather than throwing', async () => {
      const moved = join(fixtures.root, 'moved.csv');
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.mixedCsv, name: 'movable' });
      if (source === undefined) throw new Error('no source');

      await rename(fixtures.mixedCsv, moved);
      try {
        const listed = (await ws.datera.listSources()).find((s) => s.id === source.id);
        expect(listed?.status.availability).toBe('unavailable');
        expect(listed?.status.reason).toContain('no longer at');

        // And asking for its schema is a typed error, not a stack trace.
        await expect(ws.datera.getSchema(source.id)).rejects.toMatchObject({
          code: 'SOURCE_UNAVAILABLE',
        });
      } finally {
        await rename(moved, fixtures.mixedCsv);
      }
    });

    it('puts every source in the default Ungrouped dataset (decision D-04)', async () => {
      const [source] = await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv });
      expect(source?.datasetId).toBe(DEFAULT_DATASET_ID);

      const datasets = await ws.datera.listDatasets();
      expect(datasets).toHaveLength(1);
      expect(datasets[0]).toMatchObject({ id: DEFAULT_DATASET_ID, isDefault: true, schemaName: 'ds_ungrouped' });
    });
  });
});
