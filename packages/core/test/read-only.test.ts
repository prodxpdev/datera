import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { DateraError, DEFAULT_DATASET_ID } from '@datera/core';
import { fixturePaths, openTestWorkspace, type TestWorkspace } from '@datera/testkit';

/**
 * P1-06 — the read-only enforcement layer (invariants §1.1 and §1.2).
 *
 * Table-driven on purpose: the value of this suite is coverage of the *ways* a write can
 * be expressed, not depth on any one of them. Each entry is a statement that must be
 * refused before DuckDB executes it.
 */

const REFUSED: readonly { readonly label: string; readonly sql: string }[] = [
  { label: 'INSERT', sql: `INSERT INTO orders VALUES ('x','y',1,1,'2026-01-01',false)` },
  { label: 'UPDATE', sql: `UPDATE orders SET product = 'tampered'` },
  { label: 'DELETE', sql: `DELETE FROM orders` },
  { label: 'DROP TABLE', sql: `DROP TABLE orders` },
  { label: 'DROP VIEW', sql: `DROP VIEW orders` },
  { label: 'CREATE TABLE', sql: `CREATE TABLE evil (a INT)` },
  { label: 'CREATE VIEW', sql: `CREATE VIEW evil AS SELECT 1` },
  { label: 'ALTER', sql: `ALTER TABLE orders RENAME TO gone` },
  // COPY ... TO writes a file. It is the most easily overlooked write in DuckDB because
  // it does not mutate a table, and it is how a "read-only" tool exfiltrates or clobbers.
  { label: 'COPY TO file', sql: `COPY orders TO '/tmp/datera-should-never-write.csv'` },
  { label: 'EXPORT DATABASE', sql: `EXPORT DATABASE '/tmp/datera-should-never-export'` },
  // ATTACH would reach a database outside the workspace, sidestepping dataset scope.
  { label: 'ATTACH', sql: `ATTACH '/tmp/other.db' AS other` },
  { label: 'DETACH', sql: `DETACH other` },
  // INSTALL/LOAD reach the network, which is the promise in invariant §1.6.
  { label: 'INSTALL', sql: `INSTALL httpfs` },
  { label: 'LOAD', sql: `LOAD httpfs` },
  { label: 'SET', sql: `SET memory_limit = '1GB'` },
  { label: 'BEGIN', sql: `BEGIN TRANSACTION` },
  { label: 'CALL', sql: `CALL pragma_version()` },
  // The injection shape: an innocuous first statement hiding a destructive second.
  { label: 'batch hiding a DROP', sql: `SELECT 1; DROP TABLE orders;` },
  { label: 'batch hiding a DELETE', sql: `SELECT * FROM orders; DELETE FROM orders;` },
  // Even an all-SELECT batch is refused: one question, one traceable statement.
  { label: 'batch of two SELECTs', sql: `SELECT 1; SELECT 2;` },
];

const ALLOWED: readonly { readonly label: string; readonly sql: string }[] = [
  { label: 'SELECT', sql: `SELECT * FROM orders LIMIT 1` },
  { label: 'SELECT with CTE', sql: `WITH x AS (SELECT 1 AS a) SELECT * FROM x` },
  { label: 'aggregate', sql: `SELECT product, sum(revenue_cents) FROM orders GROUP BY product` },
  { label: 'DESCRIBE', sql: `DESCRIBE orders` },
  { label: 'SHOW TABLES', sql: `SHOW TABLES` },
  { label: 'SUMMARIZE', sql: `SUMMARIZE orders` },
  { label: 'EXPLAIN', sql: `EXPLAIN SELECT 1` },
  { label: 'PRAGMA table_info', sql: `PRAGMA table_info('orders')` },
  { label: 'trailing semicolon', sql: `SELECT 1;` },
];

describe('P1-06 read-only enforcement', () => {
  let ws: TestWorkspace;

  beforeAll(async () => {
    ws = await openTestWorkspace();
    const fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterAll(async () => {
    await ws.dispose();
  });

  it.each(REFUSED)('refuses $label', async ({ sql }) => {
    await expect(ws.datera.query(DEFAULT_DATASET_ID, sql)).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION',
    });
  });

  it.each(ALLOWED)('allows $label', async ({ sql }) => {
    const result = await ws.datera.query(DEFAULT_DATASET_ID, sql);
    expect(result.statementKinds.every((k) => k === 'SELECT' || k === 'EXPLAIN')).toBe(true);
  });

  it('refuses an empty statement rather than silently doing nothing', async () => {
    await expect(ws.datera.query(DEFAULT_DATASET_ID, '   ')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('is not fooled by a comment in front of a write', async () => {
    const sql = `-- just looking\n/* nothing to see */ DELETE FROM orders`;
    await expect(ws.datera.query(DEFAULT_DATASET_ID, sql)).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION',
    });
  });

  it('is not fooled by the word SELECT appearing inside a string literal', async () => {
    const sql = `UPDATE orders SET product = 'SELECT * FROM orders'`;
    await expect(ws.datera.query(DEFAULT_DATASET_ID, sql)).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION',
    });
  });

  it('names the refused statement kind when DuckDB could bind it', async () => {
    // COPY ... TO binds against a view, so the precise kind is available and reported.
    const error = await ws.datera
      .query(DEFAULT_DATASET_ID, `COPY orders TO '/tmp/datera-never.csv'`)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(DateraError.is(error, 'READ_ONLY_VIOLATION')).toBe(true);
    expect((error as DateraError).details['offending']).toEqual(['COPY']);
  });

  it('fails closed when a write cannot be bound, and says why', async () => {
    // DELETE against a view cannot bind, so no statement type exists. The guard must still
    // refuse — proving it does not depend on binding succeeding — and must carry DuckDB's
    // message so the refusal is explainable rather than mysterious.
    const error = await ws.datera
      .query(DEFAULT_DATASET_ID, 'DELETE FROM orders')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(DateraError.is(error, 'READ_ONLY_VIOLATION')).toBe(true);
    expect((error as DateraError).details['statementKinds']).toEqual(['UNKNOWN']);
    expect(String((error as DateraError).details['bindError'])).toContain('Can only delete from base table');
  });

  it('reports a broken SELECT as a query error, not as a read-only violation', async () => {
    // The distinction that the parser-level fallback exists to preserve: a typo in a table
    // name is a broken read, and calling it an attempted write would be both wrong and
    // baffling to the person who made the typo.
    const error = await ws.datera
      .query(DEFAULT_DATASET_ID, 'SELECT * FROM table_that_does_not_exist')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(DateraError.is(error, 'SQL_ERROR')).toBe(true);
    expect(String((error as DateraError).message)).toContain('table_that_does_not_exist');
  });

  it('reports malformed SQL as a query error, not as a read-only violation', async () => {
    const error = await ws.datera
      .query(DEFAULT_DATASET_ID, 'SELEKT 1')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(DateraError.is(error, 'SQL_ERROR')).toBe(true);
  });

  it('refuses a write even when it targets an attached source catalog directly', async () => {
    // Belt and braces: the guard should stop this, but DuckDB's READ_ONLY attach is the
    // second, independent mechanism. Both are asserted elsewhere; here we prove the first.
    await expect(
      ws.datera.query(DEFAULT_DATASET_ID, `INSERT INTO orders SELECT * FROM orders`),
    ).rejects.toMatchObject({ code: 'READ_ONLY_VIOLATION' });
  });
});
