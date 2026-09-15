import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  describeDifferences, fixturePaths, openTestWorkspace, startStubModelServer, testPorts,
  withUnchangedFiles,
  type FixturePaths, type StubModelServer, type TestWorkspace,
} from '@datera/testkit';

/**
 * Phase 6 — writes (spec §6, acceptance §12.7).
 *
 * "The confirm-preview gate *is* the safety mechanism and the teaching moment." So the
 * tests here are mostly about what does **not** happen: no write without a grant, no write
 * without a confirm, and no write to a source on any path whatsoever.
 */
describe('§6 write grants are off by default', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let derivedId: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    derivedId = (await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' })).datasetId;
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('reports no grant on a fresh dataset', async () => {
    expect(await ws.datera.canWrite(derivedId)).toBe(false);
  });

  it('refuses to even propose a write without a grant', async () => {
    await expect(
      ws.datera.proposeWrite(derivedId, `UPDATE orders SET product = 'x' WHERE order_id = 'A-1042'`),
    ).rejects.toMatchObject({ code: 'WRITE_NOT_PERMITTED' });
  });

  it('grants and revokes per dataset', async () => {
    await ws.datera.grantWrite(derivedId);
    expect(await ws.datera.canWrite(derivedId)).toBe(true);

    await ws.datera.revokeWrite(derivedId);
    expect(await ws.datera.canWrite(derivedId)).toBe(false);
  });

  it('a grant on one dataset does not grant another', async () => {
    const other = (await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Another copy' })).datasetId;
    await ws.datera.grantWrite(derivedId);

    expect(await ws.datera.canWrite(other)).toBe(false);
  });

  it('survives a restart, because a grant is a decision not a session flag', async () => {
    await ws.datera.grantWrite(derivedId);
    ws = await ws.reopen();
    expect(await ws.datera.canWrite(derivedId)).toBe(true);
  });

  it('refuses a grant on a dataset that reads sources (§1.2)', async () => {
    // Writes land on a derived copy, never on a dataset whose tables are views over the
    // user's actual files. There is no flag that makes this possible.
    await expect(ws.datera.grantWrite(DEFAULT_DATASET_ID)).rejects.toMatchObject({
      code: 'WRITE_NOT_PERMITTED',
    });
  });
});

describe('§12.7 propose → preview → confirm', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let derivedId: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    derivedId = (await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' })).datasetId;
    await ws.datera.grantWrite(derivedId);
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('previews the exact row count without changing anything', async () => {
    const proposal = await ws.datera.proposeWrite(
      derivedId,
      `UPDATE orders SET product = 'Renamed' WHERE refunded = false`,
    );

    expect(proposal.rowsAffected).toBe(5);
    expect(proposal.statementKind).toBe('UPDATE');

    // Nothing has happened yet.
    const check = await ws.datera.query(derivedId, `SELECT count(*) FROM orders WHERE product = 'Renamed'`);
    expect(Number(check.rows[0]?.[0])).toBe(0);
  });

  it('shows old → new values for the rows it would change', async () => {
    const proposal = await ws.datera.proposeWrite(
      derivedId,
      `UPDATE orders SET product = 'Renamed' WHERE order_id = 'A-1042'`,
    );

    expect(proposal.changes).toHaveLength(1);
    const change = proposal.changes[0]!;
    expect(change.before['product']).toBe('Trail Hoodie');
    expect(change.after['product']).toBe('Renamed');
    // Columns the statement does not touch are not presented as changing.
    expect(change.after['qty']).toBeUndefined();
  });

  it('shows the rows a DELETE would remove', async () => {
    const proposal = await ws.datera.proposeWrite(derivedId, `DELETE FROM orders WHERE refunded = true`);

    expect(proposal.statementKind).toBe('DELETE');
    expect(proposal.rowsAffected).toBe(1);
    expect(proposal.changes[0]?.before['order_id']).toBe('A-1044');
    expect(proposal.changes[0]?.after).toEqual({});
  });

  it('never executes without a confirm', async () => {
    await ws.datera.proposeWrite(derivedId, `DELETE FROM orders`);

    // The proposal exists and is not applied. This is the whole gate.
    const rows = await ws.datera.query(derivedId, 'SELECT count(*) FROM orders');
    expect(Number(rows.rows[0]?.[0])).toBe(6);
  });

  it('applies on confirm, and reports what it did', async () => {
    const proposal = await ws.datera.proposeWrite(
      derivedId,
      `UPDATE orders SET product = 'Renamed' WHERE order_id = 'A-1042'`,
    );
    const applied = await ws.datera.confirmWrite(proposal.id);

    expect(applied.rowsChanged).toBe(1);

    const rows = await ws.datera.query(derivedId, `SELECT count(*) FROM orders WHERE product = 'Renamed'`);
    expect(Number(rows.rows[0]?.[0])).toBe(1);
  });

  it('undoes a confirmed write', async () => {
    const proposal = await ws.datera.proposeWrite(derivedId, `DELETE FROM orders WHERE refunded = true`);
    const applied = await ws.datera.confirmWrite(proposal.id);

    expect(Number((await ws.datera.query(derivedId, 'SELECT count(*) FROM orders')).rows[0]?.[0])).toBe(5);

    await ws.datera.undoWrite(applied.id);

    const restored = await ws.datera.query(derivedId, 'SELECT count(*) FROM orders');
    expect(Number(restored.rows[0]?.[0])).toBe(6);

    // And the exact row is back, not just the count.
    const row = await ws.datera.query(derivedId, `SELECT product FROM orders WHERE order_id = 'A-1044'`);
    expect(row.rows[0]?.[0]).toBe('Summit Pack');
  });

  it('refuses to confirm the same proposal twice', async () => {
    const proposal = await ws.datera.proposeWrite(derivedId, `DELETE FROM orders WHERE refunded = true`);
    await ws.datera.confirmWrite(proposal.id);

    await expect(ws.datera.confirmWrite(proposal.id)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('refuses to confirm a proposal after the grant is revoked', async () => {
    const proposal = await ws.datera.proposeWrite(derivedId, `DELETE FROM orders`);
    await ws.datera.revokeWrite(derivedId);

    await expect(ws.datera.confirmWrite(proposal.id)).rejects.toMatchObject({
      code: 'WRITE_NOT_PERMITTED',
    });
  });

  it('records every write in the audit log', async () => {
    const proposal = await ws.datera.proposeWrite(
      derivedId,
      `UPDATE orders SET product = 'Renamed' WHERE order_id = 'A-1042'`,
    );
    await ws.datera.confirmWrite(proposal.id);

    const log = await ws.datera.listWrites(derivedId);
    expect(log).toHaveLength(1);
    expect(log[0]?.sql).toContain('UPDATE');
    expect(log[0]?.rowsChanged).toBe(1);
    expect(log[0]?.confirmedAt).toBeTruthy();
  });

  it('refuses a statement that is not a write at all', async () => {
    await expect(ws.datera.proposeWrite(derivedId, 'SELECT * FROM orders')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('refuses a write that reaches outside the dataset', async () => {
    await expect(
      ws.datera.proposeWrite(derivedId, `DELETE FROM ds_ungrouped.orders`),
    ).rejects.toMatchObject({ code: 'CROSS_DATASET_ACCESS' });
  });
});

describe('§1.2 a source can never be written, on any path', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('leaves the file byte-identical across a full write cycle on a copy', async () => {
    const { differences } = await withUnchangedFiles([fixtures.ordersCsv], async () => {
      const derived = await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' });
      await ws.datera.grantWrite(derived.datasetId);
      const proposal = await ws.datera.proposeWrite(derived.datasetId, 'DELETE FROM orders');
      const applied = await ws.datera.confirmWrite(proposal.id);
      await ws.datera.undoWrite(applied.id);
    });

    expect(describeDifferences(differences)).toBe('');
  });

  it('still refuses a write through the read-only query path, grant or no grant', async () => {
    const derived = await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' });
    await ws.datera.grantWrite(derived.datasetId);

    // `query` is the read path. A write grant does not turn it into a write path — writes
    // go through propose/confirm or they do not happen.
    await expect(ws.datera.query(derived.datasetId, 'DELETE FROM orders')).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION',
    });
  });
});

describe('§6 the footgun: an NL instruction that becomes a DELETE', () => {
  let ws: TestWorkspace;
  let server: StubModelServer;
  let fixtures: FixturePaths;
  let derivedId: string;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    derivedId = (await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Working copy' })).datasetId;
    await ws.datera.grantWrite(derivedId);
    await ws.datera.setChatModel({
      tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
      locality: 'local', endpoint: server.url, label: 'llama3.1:8b',
    });
  });

  afterEach(async () => {
    await ws.dispose();
    await server.close();
  });

  it('proposes, previews and waits — it does not execute', async () => {
    // The teaching moment from §6: "the AI tried to delete everything and the gate caught
    // it". The proposal must exist, be accurate, and be inert.
    server.setReply('DELETE FROM orders');

    const proposal = await ws.datera.proposeWriteFromQuestion(derivedId, 'get rid of all the orders');

    expect(proposal.statementKind).toBe('DELETE');
    expect(proposal.rowsAffected).toBe(6);
    expect(proposal.sql).toContain('DELETE');

    const rows = await ws.datera.query(derivedId, 'SELECT count(*) FROM orders');
    expect(Number(rows.rows[0]?.[0])).toBe(6);
  });

  it('warns loudly when a proposal would affect every row', async () => {
    server.setReply('DELETE FROM orders');
    const proposal = await ws.datera.proposeWriteFromQuestion(derivedId, 'get rid of all the orders');

    expect(proposal.warnings.join(' ')).toMatch(/every row|all 6/i);
  });

  it('carries the full trace, so the proposal is inspectable before confirming', async () => {
    server.setReply(`UPDATE orders SET product = 'x' WHERE refunded = true`);
    const proposal = await ws.datera.proposeWriteFromQuestion(derivedId, 'rename the refunded ones');

    expect(proposal.trace).toBeDefined();
    expect(proposal.trace?.stages.some((s) => s.kind === 'model')).toBe(true);
  });
});
