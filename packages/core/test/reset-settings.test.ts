import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID, DEFAULT_RETENTION, DEFAULT_SERVING } from '@datera/core';
import {
  fixturePaths, openTestWorkspace, testPorts,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * Putting the settings back, without throwing the data away.
 *
 * "Reset" is two very different requests wearing one word. Someone whose model choice or
 * retention window has drifted somewhere unhelpful wants the preferences back at their
 * defaults and their datasets left exactly where they are. Someone leaving wants
 * everything gone. Conflating them is how a support instruction destroys a person's work,
 * so they are separate operations and this one is explicitly the harmless half.
 */
describe('resetting settings', () => {
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

  it('puts preferences back to their defaults', async () => {
    await ws.datera.setTraceRetention({ maxRecords: 7 });
    await ws.datera.setTracePayloadCapture(true);
    await ws.datera.setServingPreference({ enabled: true, port: 9100 });

    await ws.datera.resetSettings();

    expect(await ws.datera.getTraceRetention()).toEqual(DEFAULT_RETENTION);
    expect(await ws.datera.getTracePayloadCapture()).toBe(false);
    expect(await ws.datera.getServingPreference()).toEqual(DEFAULT_SERVING);
  });

  it('leaves the data completely alone', async () => {
    // The whole reason this is a separate operation from removing everything.
    const before = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) AS n FROM orders');

    await ws.datera.resetSettings();

    const after = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) AS n FROM orders');
    expect(after.rows).toEqual(before.rows);
    expect((await ws.datera.listSources()).length).toBe(1);
    expect((await ws.datera.listDatasets()).length).toBeGreaterThan(0);
  });

  it('survives a restart, rather than being undone by cached state', async () => {
    await ws.datera.setTraceRetention({ maxRecords: 7 });
    await ws.datera.resetSettings();

    const reopened = await ws.reopen();
    expect(await reopened.datera.getTraceRetention()).toEqual(DEFAULT_RETENTION);
  });

  it('forgets a serving token, because a reset that leaves a credential is not one', async () => {
    const token = await ws.datera.servingToken();
    await ws.datera.resetSettings();

    expect(await ws.datera.servingToken()).not.toBe(token);
  });
});
