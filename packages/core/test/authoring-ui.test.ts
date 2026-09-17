import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import { openTestWorkspace, testPorts, type TestWorkspace } from '@datera/testkit';

/**
 * Author from intent (§3a) — the second entry path.
 *
 * §3a says data enters Datera two ways and both are first-class: connect a source, or
 * declare the shape you have in mind. Phase 1 built the seam — a dataset and typed tables
 * with no source behind them — and nothing above it, so the path existed and was
 * unreachable.
 *
 * What makes it useful rather than a form is the paste: "ask Claude for a schema for X"
 * and drop the result in. So the proposal accepts SQL DDL or JSON, and it is a
 * **proposal** — §1.3 applies to structure as much as to meaning.
 *
 * Deliberately NOT the §6 gate. Declaring that a customers table exists is not the same
 * act as changing 1,203 rows in one, and §3a warns that conflating them leaves the write
 * gate guarding schema edits instead of writes.
 */
describe('proposing a schema', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('reads SQL DDL, using the database rather than a regex', async () => {
    const proposal = await ws.datera.proposeSchema(
      `CREATE TABLE customers (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, region VARCHAR);
       CREATE TABLE orders (order_id VARCHAR PRIMARY KEY, customer_id VARCHAR, total_cents BIGINT);`,
    );

    expect(proposal.tables.map((t) => t.name)).toEqual(['customers', 'orders']);
    const customers = proposal.tables.find((t) => t.name === 'customers')!;
    expect(customers.columns.map((c) => c.name)).toEqual(['id', 'name', 'region']);
    expect(customers.columns.find((c) => c.name === 'id')?.primaryKey).toBe(true);
    expect(customers.columns.find((c) => c.name === 'name')?.nullable).toBe(false);
  });

  it('keeps the types the database actually resolved', async () => {
    // DECIMAL(10,2) and TIMESTAMP are not things a regex should be asked to normalise.
    const proposal = await ws.datera.proposeSchema(
      // Not "at": reserved in DuckDB for time travel, which this project has tripped over
      // before. A schema paste will meet the same wall, and the parser error says so.
      'CREATE TABLE t (price DECIMAL(10,2), occurred_at TIMESTAMP, tags VARCHAR[])',
    );

    const types = proposal.tables[0]!.columns.map((c) => c.type);
    expect(types).toContain('DECIMAL(10,2)');
    expect(types.some((t) => t.startsWith('TIMESTAMP'))).toBe(true);
  });

  it('reads JSON, which is what an assistant tends to produce', async () => {
    const proposal = await ws.datera.proposeSchema(
      JSON.stringify({
        tables: [
          {
            name: 'books',
            columns: [
              { name: 'isbn', type: 'VARCHAR', primaryKey: true },
              { name: 'title', type: 'VARCHAR', nullable: false },
              { name: 'published', type: 'DATE' },
            ],
          },
        ],
      }),
    );

    expect(proposal.tables[0]?.name).toBe('books');
    expect(proposal.tables[0]?.columns).toHaveLength(3);
  });

  it('proposes relationships a foreign key declares', async () => {
    const proposal = await ws.datera.proposeSchema(
      `CREATE TABLE customers (id VARCHAR PRIMARY KEY, name VARCHAR);
       CREATE TABLE orders (id VARCHAR, customer_id VARCHAR REFERENCES customers(id));`,
    );

    expect(proposal.relationships).toHaveLength(1);
    expect(proposal.relationships[0]).toMatchObject({
      fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id',
    });
  });

  it('changes nothing until it is applied', async () => {
    await ws.datera.proposeSchema('CREATE TABLE ghost (id VARCHAR)');
    expect(await ws.datera.listTables(DEFAULT_DATASET_ID)).not.toContain('ghost');
  });

  it('creates the tables on apply, and they are queryable immediately', async () => {
    const proposal = await ws.datera.proposeSchema(
      'CREATE TABLE books (isbn VARCHAR PRIMARY KEY, title VARCHAR)',
    );
    await ws.datera.applySchema(DEFAULT_DATASET_ID, proposal);

    expect(await ws.datera.listTables(DEFAULT_DATASET_ID)).toContain('books');
    const result = await ws.datera.query(DEFAULT_DATASET_ID, 'SELECT count(*) FROM books');
    expect(Number(result.rows[0]?.[0])).toBe(0);
  });

  it('records the relationships it proposed, once applied', async () => {
    const proposal = await ws.datera.proposeSchema(
      `CREATE TABLE customers (id VARCHAR PRIMARY KEY);
       CREATE TABLE orders (id VARCHAR, customer_id VARCHAR REFERENCES customers(id));`,
    );
    await ws.datera.applySchema(DEFAULT_DATASET_ID, proposal);

    const links = await ws.datera.listRelationships(DEFAULT_DATASET_ID);
    expect(links).toHaveLength(1);
    expect(links[0]?.fromColumn).toBe('customer_id');
  });

  it('refuses anything that is not table definition', async () => {
    // The paste box takes text someone may not have read, quite possibly written by a
    // model. It creates structure and nothing else: no reads, no writes, no attach.
    for (const hostile of [
      'DROP TABLE orders',
      'INSERT INTO orders VALUES (1)',
      "COPY (SELECT 1) TO '/tmp/leak.csv'",
      "ATTACH 'x.db'",
      'SELECT * FROM orders',
    ]) {
      await expect(ws.datera.proposeSchema(hostile), hostile).rejects.toThrow();
    }
  });

  it('reports a syntax error as the database describes it', async () => {
    // A real parser error names the position and the problem; a regex would have to
    // invent something vaguer and less true.
    await expect(ws.datera.proposeSchema('CREATE TABLE (oops')).rejects.toThrow();
  });

  it('leaves nothing behind when a paste fails', async () => {
    await expect(ws.datera.proposeSchema('CREATE TABLE a (x INT); DROP TABLE a;')).rejects.toThrow();

    // The scratch schema is cleaned up regardless, or a second attempt would collide with
    // the wreckage of the first.
    const proposal = await ws.datera.proposeSchema('CREATE TABLE a (x INT)');
    expect(proposal.tables[0]?.name).toBe('a');
  });

  it('refuses to overwrite a table that already exists', async () => {
    const proposal = await ws.datera.proposeSchema('CREATE TABLE books (isbn VARCHAR)');
    await ws.datera.applySchema(DEFAULT_DATASET_ID, proposal);

    await expect(ws.datera.applySchema(DEFAULT_DATASET_ID, proposal)).rejects.toThrow(/exists/i);
  });
});
