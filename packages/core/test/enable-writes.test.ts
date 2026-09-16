import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import { fixturePaths, fingerprintFile, openTestWorkspace, testPorts, type FixturePaths, type TestWorkspace } from '@datera/testkit';

/**
 * Enabling writes, without the ceremony (spec §1.2, §6).
 *
 * §1.2 says Datera never writes to a connected source. The mechanism is copy-on-write —
 * and the mechanism had become the user's problem: derive a copy, find the copy, grant
 * writes on the copy, remember which one you are querying. Three steps and a second entry
 * in the dataset list to express one intention.
 *
 * The invariant is about behaviour, not about making someone perform it. Asking for
 * writes on a connected dataset now makes the shadow copy itself, and says so.
 */
describe('enableWrites', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.flatSheetCsv, name: 'sheet' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('makes the shadow copy itself, and grants writes on that', async () => {
    const before = await fingerprintFile(fixtures.flatSheetCsv);

    const result = await ws.datera.enableWrites(DEFAULT_DATASET_ID);

    expect(result.derived).toBe(true);
    expect(result.datasetId).not.toBe(DEFAULT_DATASET_ID);
    expect(await ws.datera.canWrite(result.datasetId)).toBe(true);

    // The invariant it exists to protect, still protected.
    expect(await ws.datera.canWrite(DEFAULT_DATASET_ID)).toBe(false);
    expect((await fingerprintFile(fixtures.flatSheetCsv)).sha256).toBe(before.sha256);
  });

  it('carries the data across, so the copy is usable immediately', async () => {
    const { datasetId } = await ws.datera.enableWrites(DEFAULT_DATASET_ID);

    const rows = await ws.datera.query(datasetId, 'SELECT count(*) FROM sheet');
    expect(Number(rows.rows[0]?.[0])).toBe(9);
  });

  it('names the copy after what it copies, so it is identifiable in a list', async () => {
    const { datasetId } = await ws.datera.enableWrites(DEFAULT_DATASET_ID);
    const dataset = (await ws.datera.listDatasets()).find((d) => d.id === datasetId);

    expect(dataset?.name).toMatch(/ungrouped/i);
    expect(dataset?.kind).toBe('derived');
  });

  it('just grants when the dataset is already a working copy', async () => {
    const first = await ws.datera.enableWrites(DEFAULT_DATASET_ID);
    await ws.datera.revokeWrite(first.datasetId);

    const again = await ws.datera.enableWrites(first.datasetId);

    // No second copy: the point is one copy per thing being worked on, not one per click.
    expect(again.derived).toBe(false);
    expect(again.datasetId).toBe(first.datasetId);
    expect((await ws.datera.listDatasets()).filter((d) => d.kind === 'derived')).toHaveLength(1);
  });

  it('reuses the copy it already made rather than stacking them up', async () => {
    const first = await ws.datera.enableWrites(DEFAULT_DATASET_ID);
    const second = await ws.datera.enableWrites(DEFAULT_DATASET_ID);

    expect(second.datasetId).toBe(first.datasetId);
    expect((await ws.datera.listDatasets()).filter((d) => d.kind === 'derived')).toHaveLength(1);
  });
});
