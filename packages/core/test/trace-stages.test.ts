import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths, openTestWorkspace, startStubModelServer, testPorts,
  type FixturePaths, type StubModelServer, type TestWorkspace,
} from '@datera/testkit';

/**
 * The execution sequence, for requests that already happened (§12.9, §8a).
 *
 * Stages were read out of a trace for the model name and the SQL and then thrown away, so
 * the step-by-step view existed only in the live answer drawer. The moment you looked at
 * a past request — which is the entire purpose of a persisted log — the thing the product
 * is built to show you was gone.
 */
describe('recorded traces keep every hop', () => {
  let ws: TestWorkspace;
  let server: StubModelServer;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.setChatModel({
      tier: 'detected', provider: 'openai-compatible', id: 'stub',
      role: 'chat', locality: 'local', endpoint: server.url, label: 'stub',
    });
  });

  afterEach(async () => {
    await ws.dispose();
    await server.close();
  });

  it('keeps the whole pipeline, in order, for an ask', async () => {
    server.setReply('SELECT product, sum(revenue_cents) AS revenue FROM orders GROUP BY product');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'revenue by product');

    const [record] = await ws.datera.queryTraceLog({ limit: 1 });
    const kinds = record!.stages.map((s) => s.kind);

    expect(kinds).toContain('route');
    expect(kinds).toContain('schema');
    expect(kinds).toContain('model');
    expect(kinds).toContain('guard');
    expect(kinds).toContain('execute');
    // Order, not just presence: a trace that lists the hops out of sequence is not a
    // record of what happened.
    expect(kinds.indexOf('model')).toBeLessThan(kinds.indexOf('execute'));
  });

  it('carries the SQL and the model name into the stored steps', async () => {
    server.setReply('SELECT count(*) AS n FROM orders');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'how many orders');

    const [record] = await ws.datera.queryTraceLog({ limit: 1 });
    expect(record!.stages.some((s) => (s.sql ?? '').includes('orders'))).toBe(true);
    expect(record!.stages.some((s) => s.modelName !== undefined)).toBe(true);
  });

  it('records the steps of a hand-written query too', async () => {
    await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders');

    const [record] = await ws.datera.queryTraceLog({ limit: 1 });
    expect(record!.stages.length).toBeGreaterThan(0);
  });

  it('does not put the model payload in the steps', async () => {
    // Payloads stay behind the capture flag. Putting prompt text into a column that is
    // always written would quietly undo that decision.
    server.setReply('SELECT count(*) AS n FROM orders');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'how many orders');

    const [record] = await ws.datera.queryTraceLog({ limit: 1 });
    const serialised = JSON.stringify(record!.stages);
    expect(serialised).not.toContain('You translate');
    expect(record!.payload).toBeNull();
  });
});
