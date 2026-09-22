import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_DATABASE, WORKSPACE_FORMAT_VERSION, WORKSPACE_MANIFEST, workspacePaths } from '@datera/core';
import { fixturePaths, openTestWorkspace, type TestWorkspace } from '@datera/testkit';

/** P1-04 + P1-07 — engine lifecycle and the portable workspace directory (decision D-05). */
describe('P1-04/P1-07 engine and workspace', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace();
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('reports engine provenance for the transparency layer', () => {
    const info = ws.datera.engineInfo();
    expect(info.duckdbVersion).toMatch(/^v\d+\.\d+/);
    expect(info.driver).toBe('duckdb-node-api');
    expect(info.workspace.formatVersion).toBe(WORKSPACE_FORMAT_VERSION);
  });

  it('creates a portable workspace directory that can simply be copied', async () => {
    // Decision D-05: the layout is a cross-repo contract, because Datera Server takes a
    // DATERA_WORKSPACE path. Copying the directory has to be sufficient to move it.
    const paths = workspacePaths(ws.workspacePath);
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as Record<string, unknown>;

    expect(manifest['formatVersion']).toBe(WORKSPACE_FORMAT_VERSION);
    expect(typeof manifest['id']).toBe('string');
    expect(typeof manifest['createdAt']).toBe('string');
    expect(paths.manifestPath.endsWith(WORKSPACE_MANIFEST)).toBe(true);
    expect(paths.databasePath.endsWith(WORKSPACE_DATABASE)).toBe(true);
  });

  it('reopens an existing workspace rather than recreating it', async () => {
    const before = ws.datera.engineInfo().workspace.id;
    ws = await ws.reopen();
    expect(ws.datera.engineInfo().workspace.id).toBe(before);
  });

  it('refuses a workspace written by a newer Datera, with an actionable message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'datera-future-'));
    try {
      await writeFile(
        join(dir, WORKSPACE_MANIFEST),
        JSON.stringify({ formatVersion: 999, id: 'x', name: 'x', createdAt: 'x', createdBy: 'x' }),
      );

      await expect(openTestWorkspace({ workspacePath: dir })).rejects.toMatchObject({
        code: 'WORKSPACE_FORMAT_UNSUPPORTED',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a corrupt manifest as a typed error rather than a parse crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'datera-corrupt-'));
    try {
      await writeFile(join(dir, WORKSPACE_MANIFEST), '{ not json');
      await expect(openTestWorkspace({ workspacePath: dir })).rejects.toMatchObject({
        code: 'WORKSPACE_FORMAT_UNSUPPORTED',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps Datera’s bookkeeping out of the dataset schemas', async () => {
    const fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });

    // The catalog lives in `_datera`, so a user browsing their workspace can tell instantly
    // which objects are theirs and which are Datera's — and a dataset can never collide
    // with the bookkeeping.
    const tables = await ws.datera.listTables('ungrouped');
    expect(tables).toEqual(['orders']);
  });

  it('closes cleanly and releases the database file', async () => {
    const path = ws.workspacePath;
    await ws.datera.close();

    // Reopening the same directory in a fresh instance proves nothing was left locked.
    const reopened = await openTestWorkspace({ workspacePath: path });
    expect(reopened.datera.engineInfo().workspacePath).toBe(path);
    await reopened.datera.close();

    // Keep afterEach's dispose from double-closing.
    ws = { ...ws, datera: reopened.datera, dispose: async () => rm(path, { recursive: true, force: true }) };
  });

  it('reports a missing dataset as a typed error', async () => {
    await expect(ws.datera.getDataset('nope')).rejects.toMatchObject({ code: 'DATASET_NOT_FOUND' });
  });

  it('reports a missing source as a typed error', async () => {
    await expect(ws.datera.getSource('nope')).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });
});
