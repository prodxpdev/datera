import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DEFAULT_DATASET_ID } from '@datera/core';
import { openTestWorkspace, stagedExtensionDirectory, testPorts, type TestWorkspace } from '@datera/testkit';

/**
 * Opening a workspace created by an older Datera.
 *
 * This suite exists because of a bug that reached a user: every other test creates a
 * *fresh* workspace, so the upgrade path was never exercised once. The Phase 5 migration
 * used `ALTER TABLE ... ADD COLUMN kind VARCHAR NOT NULL DEFAULT 'connected'`, which
 * DuckDB rejects ("Adding columns with constraints not yet supported") — and a
 * `catch {}` swallowed the failure, so the column was never added and the app refused to
 * start on any workspace older than that release.
 *
 * Two lessons are encoded here: migrations get tested against the *old* shape, and a
 * migration never silently gives up.
 */

/** Build a workspace the way Datera did before Phase 5 added kind/derived_from. */
async function makeLegacyWorkspace(root: string): Promise<void> {
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        id: 'legacy-workspace',
        name: 'Legacy',
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: '0.1.0',
      },
      null,
      2,
    ),
  );

  const instance = await DuckDBInstance.create(join(root, 'workspace.duckdb'), {
    extension_directory: stagedExtensionDirectory(),
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  const conn = await instance.connect();

  await conn.run('CREATE SCHEMA IF NOT EXISTS _datera');
  // The pre-Phase-5 shape: no kind, no derived_from.
  await conn.run(`
    CREATE TABLE _datera.datasets (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      description VARCHAR NOT NULL DEFAULT '',
      schema_name VARCHAR NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_at VARCHAR NOT NULL
    )`);
  await conn.run(`
    INSERT INTO _datera.datasets VALUES
      ('ungrouped', 'Ungrouped', 'The original', 'ds_ungrouped', true, '2026-01-01T00:00:00.000Z')`);
  await conn.run('CREATE SCHEMA IF NOT EXISTS ds_ungrouped');
  await conn.run('CREATE TABLE ds_ungrouped.legacy_table AS SELECT 1 AS a, 2 AS b');

  conn.closeSync();
  instance.closeSync();
}

describe('opening a pre-Phase-5 workspace', () => {
  let root: string;
  let ws: TestWorkspace | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'datera-legacy-'));
    await makeLegacyWorkspace(root);
  });

  afterEach(async () => {
    await ws?.datera.close();
    ws = null;
    await rm(root, { recursive: true, force: true });
  });

  it('opens without error', async () => {
    // The user-visible failure: "Datera could not open its workspace — Referenced column
    // 'kind' not found in FROM clause".
    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });
    expect(ws.datera.engineInfo().workspace.id).toBe('legacy-workspace');
  });

  it('adds the missing columns rather than recreating the table', async () => {
    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });

    // The user's datasets. Datera's own activity log (§8a) is a system dataset and is
    // deliberately not counted here — this test is about migrating what a user had.
    const datasets = (await ws.datera.listDatasets()).filter((d) => d.kind !== 'system');
    expect(datasets).toHaveLength(1);
    expect(datasets[0]?.id).toBe(DEFAULT_DATASET_ID);
    // The existing row survived, with its original values.
    expect(datasets[0]?.description).toBe('The original');
    expect(datasets[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('backfills the new column for existing rows', async () => {
    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });

    const datasets = await ws.datera.listDatasets();
    // A pre-existing dataset reads its sources directly, so 'connected' is the right
    // answer — and it matters, because 'derived' would let writes be granted on it.
    expect(datasets[0]?.kind).toBe('connected');
    expect(datasets[0]?.derivedFrom).toBeUndefined();
  });

  it('keeps the data that was already in the workspace', async () => {
    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });

    const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT a, b FROM legacy_table');
    expect(result.rows[0]).toEqual([1, 2]);
  });

  it('refuses a write grant on the migrated dataset, as §1.2 requires', async () => {
    // The consequence of backfilling `connected` correctly: a dataset that reads sources
    // can never be granted writes, migration or not.
    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });

    await expect(ws.datera.grantWrite(DEFAULT_DATASET_ID)).rejects.toMatchObject({
      code: 'WRITE_NOT_PERMITTED',
    });
  });

  it('is idempotent — opening twice does not break', async () => {
    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });
    await ws.datera.close();

    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });
    expect((await ws.datera.listDatasets())[0]?.kind).toBe('connected');
  });

  it('works end to end after migrating', async () => {
    ws = await openTestWorkspace({ workspacePath: root, ports: testPorts() });

    // The features added after this workspace was created must work on it.
    const derived = await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Copy' });
    expect((await ws.datera.getDataset(derived.datasetId)).kind).toBe('derived');

    await ws.datera.grantWrite(derived.datasetId);
    expect(await ws.datera.canWrite(derived.datasetId)).toBe(true);
  });
});

describe('migrations do not fail silently', () => {
  it('surfaces a migration failure rather than swallowing it', async () => {
    // The bug was not the rejected ALTER — it was the empty catch. A migration that
    // cannot do its job must say so at startup, not leave a half-shaped catalog for a
    // later query to trip over with an incomprehensible binder error.
    const root = await mkdtemp(join(tmpdir(), 'datera-broken-'));
    try {
      await writeFile(
        join(root, 'workspace.json'),
        JSON.stringify({ formatVersion: 1, id: 'x', name: 'x', createdAt: 'x', createdBy: 'x' }),
      );

      const instance = await DuckDBInstance.create(join(root, 'workspace.duckdb'), {
        extension_directory: stagedExtensionDirectory(),
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
      });
      const conn = await instance.connect();
      await conn.run('CREATE SCHEMA IF NOT EXISTS _datera');
      // A `datasets` that is a *view*, so ALTER cannot possibly succeed.
      await conn.run(`CREATE VIEW _datera.datasets AS SELECT 'x' AS id, 'x' AS name`);
      conn.closeSync();
      instance.closeSync();

      await expect(openTestWorkspace({ workspacePath: root, ports: testPorts() })).rejects.toThrow(
        /could not be upgraded|migration/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
