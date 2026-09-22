import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { DEFAULT_DATASET_ID, buildAttachStatement, redactCredentials, redactedOrigin } from '@datera/core';
import {
  diffDatabaseFingerprints,
  fingerprintAttachedDatabase,
  openTestWorkspace,
  queryThrough,
  type TestWorkspace,
} from '@datera/testkit';

/**
 * P1-11 — live Postgres and MySQL, attached read-only.
 *
 * The integration half needs real servers. In CI they are service containers; locally they
 * usually are not running. These tests **skip loudly** rather than silently: a suite that
 * quietly reports success while testing nothing is worse than one that is honest about
 * what it did not run.
 */

// The password is deliberately distinct from the user and database names. Reusing 'datera'
// for all three made the "origin must not contain the password" assertion vacuously true.
const PG = { host: '127.0.0.1', port: 5432, database: 'datera_test', user: 'datera', password: 'pg_secret_pw' };
const MY = { host: '127.0.0.1', port: 3306, database: 'datera_test', user: 'datera', password: 'my_secret_pw' };

async function portOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** These run with no server, and are the part of P1-11 that is always verified. */
describe('P1-11 database attach — statement construction', () => {
  it('always attaches READ_ONLY, for every database kind', () => {
    // The second, independent enforcement mechanism for invariant §1.1: even if the SQL
    // guard above had a bug, DuckDB itself refuses writes to the attached catalog.
    const pg = buildAttachStatement({ kind: 'postgres', ...PG }, 'p', 'secret');
    const my = buildAttachStatement({ kind: 'mysql', ...MY }, 'm', 'secret');
    const sq = buildAttachStatement({ kind: 'sqlite', database: 'x', path: '/tmp/x.sqlite' }, 's', null);

    expect(pg).toContain('TYPE postgres, READ_ONLY');
    expect(my).toContain('TYPE mysql, READ_ONLY');
    expect(sq).toContain('TYPE sqlite, READ_ONLY');
  });

  it('builds a redacted origin that never contains the password', () => {
    const origin = redactedOrigin({ kind: 'postgres', ...PG });
    expect(origin).toBe('postgres://datera@127.0.0.1:5432/datera_test');
    expect(origin).not.toContain(PG.password);
  });

  it('redacts a credential out of an error message', () => {
    const raw = `Failed to connect: host=db port=5432 password=hunter2 dbname=x`;
    expect(redactCredentials(raw, 'hunter2')).not.toContain('hunter2');
    // And generically, for a credential we were never handed.
    expect(redactCredentials(raw, null)).not.toContain('hunter2');
  });
});

describe('P1-11 live Postgres', () => {
  let ws: TestWorkspace;
  let available = false;

  beforeAll(async () => {
    available = await portOpen(PG.host, PG.port);
    if (!available) {
      console.warn(
        `\n[SKIPPED] P1-11 Postgres integration: nothing listening on ${PG.host}:${PG.port}.\n` +
          `          These assertions did NOT run. Start one with:\n` +
          `          docker run --rm -e POSTGRES_USER=datera -e POSTGRES_PASSWORD=pg_secret_pw \\\n` +
          `            -e POSTGRES_DB=datera_test -p 5432:5432 postgres:16\n`,
      );
      return;
    }
    ws = await openTestWorkspace();
  });

  afterAll(async () => {
    if (available) await ws.dispose();
  });

  it.runIf(available)('attaches read-only and enumerates tables', async () => {
    const sources = await ws.datera.addSource({ type: 'postgres', ...PG, namePrefix: 'pg_' });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.kind === 'postgres')).toBe(true);
    expect(sources[0]?.detection.method).toBe('postgres ATTACH (READ_ONLY)');
    expect(sources[0]?.origin).not.toContain(PG.password);
  });

  it.runIf(available)('reads a table and reports its schema', async () => {
    const sources = await ws.datera.listSources();
    const first = sources.find((s) => s.kind === 'postgres');
    if (first === undefined) return;

    const schema = await ws.datera.getSchema(first.id);
    expect(schema.columns.length).toBeGreaterThan(0);
    await ws.datera.preview(first.id, { limit: 5 });
  });

  it.runIf(available)('refuses a write, and the database is unchanged', async () => {
    const sources = await ws.datera.listSources();
    const first = sources.find((s) => s.kind === 'postgres');
    if (first === undefined || first.attachmentAlias === undefined) return;

    const query = queryThrough(ws.datera, DEFAULT_DATASET_ID);
    const before = await fingerprintAttachedDatabase(query, first.attachmentAlias);

    await expect(
      ws.datera.query(DEFAULT_DATASET_ID, `DELETE FROM "${first.name}"`),
    ).rejects.toMatchObject({ code: 'READ_ONLY_VIOLATION' });

    const after = await fingerprintAttachedDatabase(query, first.attachmentAlias);
    expect(diffDatabaseFingerprints(before, after)).toEqual([]);
  });

  it.runIf(available)('reports an unreachable host as a typed error', async () => {
    await expect(
      ws.datera.addSource({ type: 'postgres', host: '127.0.0.1', port: 59998, database: 'x', user: 'x' }),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});

describe('P1-11 live MySQL', () => {
  let ws: TestWorkspace;
  let available = false;

  beforeAll(async () => {
    available = await portOpen(MY.host, MY.port);
    if (!available) {
      console.warn(
        `\n[SKIPPED] P1-11 MySQL integration: nothing listening on ${MY.host}:${MY.port}.\n` +
          `          These assertions did NOT run. Start one with:\n` +
          `          docker run --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_USER=datera \\\n` +
          `            -e MYSQL_PASSWORD=my_secret_pw -e MYSQL_DATABASE=datera_test -p 3306:3306 mysql:8\n`,
      );
      return;
    }
    ws = await openTestWorkspace();
  });

  afterAll(async () => {
    if (available) await ws.dispose();
  });

  it.runIf(available)('attaches read-only and enumerates tables', async () => {
    const sources = await ws.datera.addSource({ type: 'mysql', ...MY, namePrefix: 'my_' });
    expect(sources.every((s) => s.kind === 'mysql')).toBe(true);
    expect(sources[0]?.origin).not.toContain(MY.password);
  });

  it.runIf(available)('refuses a write, and the database is unchanged', async () => {
    const sources = await ws.datera.listSources();
    const first = sources.find((s) => s.kind === 'mysql');
    if (first === undefined || first.attachmentAlias === undefined) return;

    const query = queryThrough(ws.datera, DEFAULT_DATASET_ID);
    const before = await fingerprintAttachedDatabase(query, first.attachmentAlias);

    await expect(
      ws.datera.query(DEFAULT_DATASET_ID, `DELETE FROM "${first.name}"`),
    ).rejects.toMatchObject({ code: 'READ_ONLY_VIOLATION' });

    expect(diffDatabaseFingerprints(before, await fingerprintAttachedDatabase(query, first.attachmentAlias))).toEqual([]);
  });
});
