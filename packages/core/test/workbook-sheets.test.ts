import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  openTestWorkspace, testPorts, writeXlsx,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * Multi-sheet workbooks (#31).
 *
 * Connecting an .xlsx read the workbook's first sheet and said so in the detection
 * panel — but there was no way to find out what the other sheets were called, and
 * `sheet` could only be passed by someone who already knew. For the single most common
 * "I have a spreadsheet" case, that is the whole feature missing.
 */
describe('workbook sheets', () => {
  let ws: TestWorkspace;
  let dir: string;
  let workbook: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'datera-wb-'));
    workbook = join(dir, 'book.xlsx');
    await writeXlsx(workbook, [
      { name: 'Orders', rows: [['order_id', 'qty'], ['A-1', 2]] },
      { name: 'Customers', rows: [['id', 'name'], ['C-1', 'Ann']] },
      { name: 'Q3 Summary', rows: [['metric', 'value'], ['revenue', 10]] },
    ]);
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists every sheet, in workbook order', async () => {
    expect(await ws.datera.listWorkbookSheets(workbook)).toEqual([
      'Orders', 'Customers', 'Q3 Summary',
    ]);
  });

  it('keeps a sheet name with a space intact', async () => {
    // Sheet names are display strings, not identifiers. Mangling them here would mean
    // passing back a name read_xlsx does not accept.
    expect(await ws.datera.listWorkbookSheets(workbook)).toContain('Q3 Summary');
  });

  it('connects a named sheet as its own source', async () => {
    const [source] = await ws.datera.addSource({
      type: 'file', path: workbook, name: 'customers', sheet: 'Customers',
    });

    const schema = await ws.datera.getSchema(source!.id);
    expect(schema.columns.map((c) => c.name)).toContain('name');
  });

  it('connects several sheets from one workbook as separate sources', async () => {
    for (const sheet of ['Orders', 'Customers']) {
      await ws.datera.addSource({
        type: 'file', path: workbook, name: sheet.toLowerCase(), sheet,
      });
    }

    const tables = await ws.datera.listTables(DEFAULT_DATASET_ID);
    expect(tables).toEqual(expect.arrayContaining(['orders', 'customers']));

    // And they are genuinely different sheets, not the same one twice.
    const customers = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT name FROM customers');
    expect(String(customers.rows[0]?.[0])).toBe('Ann');
  });

  it('returns nothing for a file that is not a workbook, rather than throwing', async () => {
    // A picker asking "which sheet?" about a CSV is a worse failure than a quiet empty
    // list, and this is called speculatively when a file is chosen.
    expect(await ws.datera.listWorkbookSheets(join(dir, 'missing.xlsx'))).toEqual([]);
  });
});
