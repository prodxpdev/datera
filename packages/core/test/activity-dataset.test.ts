import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_DATASET_ID, DEFAULT_DATASET_ID,
} from '@datera/core';
import {
  fixturePaths, openTestWorkspace, testPorts,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * The trace log, as a dataset (§8a, §12.9a).
 *
 * §8a says the log is "a queryable log dataset", "searchable by both SQL and NL, with the
 * SQL shown", and explicitly that it must not become its own pillar with a second UI
 * language and a second query stack behind it.
 *
 * Those two requirements pulled against each other: the log lives in the `_datera`
 * catalog schema, which the dataset guard refuses to read through the user query path —
 * correctly, because that schema holds the workspace's own bookkeeping. Making the log a
 * dataset in its own right is what resolves it: one reserved schema holding exactly one
 * view over the log, and nothing else. The `_datera` block stays absolute.
 *
 * The payoff is that nothing new had to be built. The Query editor, NL→SQL, completions,
 * the schema map and "here is the SQL that ran" already work on datasets.
 */
describe('the activity log dataset', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    // Something to find in the log.
    await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders');
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('appears as a dataset, like any other', async () => {
    const dataset = (await ws.datera.listDatasets()).find((d) => d.id === ACTIVITY_DATASET_ID);
    expect(dataset).toBeDefined();
    expect(dataset?.kind).toBe('system');
  });

  it('is queryable with ordinary SQL', async () => {
    const result = await ws.datera.query(
      ACTIVITY_DATASET_ID,
      'SELECT route, question, total_ms FROM requests ORDER BY occurred_at DESC LIMIT 5',
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.map((c) => c.name)).toContain('question');
  });

  it('answers the question a fixed filter set cannot', async () => {
    // The reason this was worth doing rather than keeping the typed filters: aggregates.
    const result = await ws.datera.query(
      ACTIVITY_DATASET_ID,
      'SELECT route, count(*) AS calls, sum(cost_usd) AS spent FROM requests GROUP BY route',
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('exposes the log and nothing else from the catalog', async () => {
    // The whole safety argument. One view, not a window onto `_datera`.
    expect(await ws.datera.listTables(ACTIVITY_DATASET_ID)).toEqual(['requests']);

    await expect(
      ws.datera.query(ACTIVITY_DATASET_ID, 'SELECT * FROM _datera.sources'),
    ).rejects.toThrow();
    await expect(
      ws.datera.query(ACTIVITY_DATASET_ID, 'SELECT * FROM _datera.environments'),
    ).rejects.toThrow();
  });

  it('keeps the catalog unreadable from an ordinary dataset', async () => {
    // Unchanged by any of this, and asserted here because it is the thing being traded
    // against.
    await expect(
      ws.datera.query(DEFAULT_DATASET_ID, 'SELECT * FROM _datera.trace_log'),
    ).rejects.toThrow();
  });

  it('is read-only, and cannot be made otherwise', async () => {
    // A log you can edit is not a log.
    await expect(ws.datera.enableWrites(ACTIVITY_DATASET_ID)).rejects.toThrow(/log|read-only|system/i);
    await expect(
      ws.datera.query(ACTIVITY_DATASET_ID, 'DELETE FROM requests'),
    ).rejects.toThrow();
  });

  it('cannot be pushed to a server', async () => {
    // Someone else's infrastructure is the last place this workspace's request history
    // should end up by accident.
    await expect(ws.datera.pushDataset(ACTIVITY_DATASET_ID, 'anywhere')).rejects.toThrow();
  });

  it('does not collect sources, and is not the default', async () => {
    const dataset = (await ws.datera.listDatasets()).find((d) => d.id === ACTIVITY_DATASET_ID);
    expect(dataset?.isDefault).toBe(false);

    const source = (await ws.datera.listSources())[0]!;
    await expect(ws.datera.moveSource(source.id, ACTIVITY_DATASET_ID)).rejects.toThrow();
  });

  it('reflects new activity without anything being rebuilt', async () => {
    const before = await ws.datera.query(ACTIVITY_DATASET_ID, 'SELECT count(*) AS n FROM requests');
    await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT 1 AS x');

    const after = await ws.datera.query(ACTIVITY_DATASET_ID, 'SELECT count(*) AS n FROM requests');
    expect(Number(after.rows[0]?.[0])).toBeGreaterThan(Number(before.rows[0]?.[0]));
  });
});
