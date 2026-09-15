import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths,
  openTestWorkspace,
  testPorts,
  withEgressBlocked,
  type FixturePaths,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * P1-05 + decision D-12 — extensions are staged, never fetched at query time.
 *
 * Invariant §1.6 promises Datera works out of the box with nothing leaving the machine.
 * An extension silently downloaded the first time someone opens a spreadsheet breaks that
 * promise at the worst possible moment: offline, on a locked-down classroom network,
 * mid-demo. So the whole connect path runs with egress blocked.
 */
describe('P1-05 sources connect with no network egress', () => {
  let fixtures: FixturePaths;

  beforeEach(() => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
  });

  it('opens a workspace and connects every file format offline', async () => {
    const { result, attempts } = await withEgressBlocked(async () => {
      const ws = await openTestWorkspace();
      try {
        await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
        await ws.datera.addSource({ type: 'file', path: fixtures.ordersParquet, name: 'parq' });
        await ws.datera.addSource({ type: 'file', path: fixtures.notesNdjson, name: 'notes' });
        await ws.datera.addSource({ type: 'file', path: fixtures.workbookXlsx, name: 'wb' });
        await ws.datera.addSource({ type: 'sqlite', path: fixtures.customersSqlite });

        const sources = await ws.datera.listSources();
        for (const source of sources) await ws.datera.getSchema(source.id);

        // Awaited before returning: `return promise` inside a try lets the finally block
        // close the database while the query is still in flight.
        return await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM orders');
      } finally {
        await ws.dispose();
      }
    });

    expect(attempts, `unexpected egress: ${attempts.map((a) => a.target).join(', ')}`).toEqual([]);
    expect(Number(result.rows[0]?.[0])).toBe(6);
  });

  it('loads the extensions .xlsx and SQLite need from the staged directory, offline', async () => {
    const { result, attempts } = await withEgressBlocked(async () => {
      const ws = await openTestWorkspace();
      try {
        return ws.datera.engineInfo();
      } finally {
        await ws.dispose();
      }
    });

    expect(attempts).toEqual([]);
    const loaded = result.extensions.filter((e) => e.loaded).map((e) => e.name);
    expect(loaded).toContain('excel');
    expect(loaded).toContain('sqlite_scanner');
    expect(loaded).toContain('postgres_scanner');
    expect(loaded).toContain('mysql_scanner');
  });

  describe('negative control — the egress guard must be able to fail', () => {
    it('records an outbound attempt', async () => {
      const { attempts } = await withEgressBlocked(async () => {
        const https = await import('node:https');
        try {
          https.request('https://example.invalid/');
        } catch {
          // Expected: the guard throws.
        }
      });

      expect(attempts.length).toBeGreaterThan(0);
      // Which layer catches it is not the interesting part, and it varies: patching the CJS
      // module object does not retroactively rebind an ESM namespace import, so the call may
      // reach the original `https.request` and be caught one level down at `tls.connect`.
      // That is exactly why the guard patches several layers rather than trusting one.
      expect(
        attempts.some((a) => ['https.request', 'tls.connect', 'net.connect', 'net.Socket.connect', 'dns.lookup'].includes(a.api)),
        `unexpected APIs: ${attempts.map((a) => a.api).join(', ')}`,
      ).toBe(true);
    });
  });
});

/**
 * P1-20 — credentials live in the OS keychain (decision D-06).
 *
 * The assertion that matters here is an absence: after a full connect cycle, the
 * credential must appear nowhere on disk and nowhere in the log. Absence is only
 * assertable against a store and a logger that can be inspected, which is what the
 * testkit's fakes are for.
 */
describe('P1-20 credential handling', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  const SECRET = 'correct-horse-battery-staple';

  it('refuses to connect with a password when no protected store is available', async () => {
    ws.ports.secrets.setAvailable(false);

    await expect(
      ws.datera.addSource({
        type: 'postgres',
        host: 'localhost',
        database: 'nope',
        user: 'someone',
        password: SECRET,
      }),
    ).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' });

    // And it did not fall back to storing it somewhere else.
    expect(ws.ports.secrets.snapshot().size).toBe(0);
  });

  it('never writes a credential to the workspace directory or the log', async () => {
    // The connection itself will fail — there is no Postgres here — which is precisely the
    // interesting case: the failure path must not leak the credential either. The ATTACH
    // statement contains the password, so an error that echoed the statement would leak it.
    await ws.datera
      .addSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: 59999,
        database: 'absent',
        user: 'someone',
        password: SECRET,
      })
      .catch(() => undefined);

    // It went to the store.
    const stored = [...ws.ports.secrets.snapshot().values()];
    expect(stored).toContain(SECRET);

    // And nowhere else: not in any file in the workspace directory...
    const files = await readdir(ws.workspacePath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const contents = await readFile(join(ws.workspacePath, file.name));
      expect(
        contents.includes(SECRET),
        `credential found in ${file.name}`,
      ).toBe(false);
    }

    // ...and not in the log stream.
    expect(ws.ports.logger.serialise()).not.toContain(SECRET);
  });

  it('reports a failed database connection without echoing the connection string', async () => {
    const error = await ws.datera
      .addSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: 59999,
        database: 'absent',
        user: 'someone',
        password: SECRET,
      })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error).not.toBeNull();
    expect(error?.message).not.toContain(SECRET);
    expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toContain(SECRET);
    // It still says something useful about what failed.
    expect(error?.message).toContain('postgres://someone@127.0.0.1:59999/absent');
  });

  it('round-trips a stored credential', async () => {
    await ws.ports.secrets.set('db:test', SECRET);
    expect(await ws.ports.secrets.get('db:test')).toBe(SECRET);
    await ws.ports.secrets.delete('db:test');
    expect(await ws.ports.secrets.get('db:test')).toBeNull();
  });
});
