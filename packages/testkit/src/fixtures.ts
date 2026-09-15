import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { writeXlsx } from './xlsx-writer.js';

/**
 * Canonical fixtures, generated rather than committed.
 *
 * Generated so that the Parquet and SQLite fixtures are written by the same DuckDB
 * version that will read them, and so a binary blob never has to be reviewed in a diff.
 * The content mirrors the prototype's sample data, so a failing assertion reads against
 * data the team already recognises.
 */

export interface FixturePaths {
  readonly root: string;
  readonly ordersCsv: string;
  readonly quotedCsv: string;
  readonly raggedCsv: string;
  readonly mixedCsv: string;
  readonly ordersTsv: string;
  readonly notesNdjson: string;
  readonly nestedJson: string;
  readonly ordersParquet: string;
  readonly workbookXlsx: string;
  readonly customersSqlite: string;
  readonly largeParquet: string;
  readonly wideCsv: string;
}

export function fixturePaths(root: string): FixturePaths {
  return {
    root,
    ordersCsv: join(root, 'orders.csv'),
    quotedCsv: join(root, 'quoted.csv'),
    raggedCsv: join(root, 'ragged.csv'),
    mixedCsv: join(root, 'mixed_types.csv'),
    ordersTsv: join(root, 'orders.tsv'),
    notesNdjson: join(root, 'support_notes.ndjson'),
    nestedJson: join(root, 'nested.json'),
    ordersParquet: join(root, 'orders.parquet'),
    workbookXlsx: join(root, 'workbook.xlsx'),
    customersSqlite: join(root, 'customers.sqlite'),
    largeParquet: join(root, 'large.parquet'),
    wideCsv: join(root, 'studio_results_20260421_1238.csv'),
  };
}

export function defaultFixtureRoot(): string {
  // packages/testkit/src -> repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'fixtures', 'generated');
}

const ORDERS_CSV = `order_id,product,revenue_cents,qty,created_at,refunded
A-1042,Trail Hoodie,8900,1,2026-05-14T09:12:00,false
A-1043,Wool Beanie,2400,2,2026-05-14T11:03:00,false
A-1044,Summit Pack,12900,1,2026-01-09T15:40:00,true
A-1045,Trail Socks,1600,3,2026-05-15T08:21:00,false
A-1046,Trail Hoodie,8900,1,2026-04-02T17:55:00,false
A-1047,Base Layer,5400,2,2026-04-19T12:30:00,false
`;

/** A comma inside a quoted field and an embedded double quote — the classic CSV trap. */
const QUOTED_CSV = `id,description,amount
1,"Hoodie, blue",8900
2,"A 12"" ruler",1200
3,"Line one
line two",450
`;

/** More fields on one row than the header declares. DuckDB must be asked what it did. */
const RAGGED_CSV = `id,name,city
1,Ada,London
2,Grace,New York,NY
3,Alan,
`;

/**
 * Mostly integers, three values that are not. Drives the ambiguity assertion in P1-12.
 *
 * The thousands-separated value is quoted deliberately. Unquoted, it would be a third field
 * on a two-field row, which sends DuckDB's sniffer down the fallback path — and this fixture
 * is meant to exercise *type ambiguity*, not raggedness. The ragged case has its own fixture.
 */
const MIXED_CSV = `id,amount
1,100
2,250
3,N/A
4,410
5,"1,200"
6,530
7,unknown
8,640
9,720
10,830
`;

const NOTES_NDJSON = `{"order_id":"A-1042","note":"Item arrived cracked.","channel":"email"}
{"order_id":"A-1108","note":"Box crushed in transit.","channel":"chat"}
{"order_id":"A-1044","note":"Requested a refund, processed.","channel":"email"}
`;

const NESTED_JSON = `[
  {"id": 1, "customer": {"name": "Northwind", "plan": "Pro"}, "tags": ["a", "b"]},
  {"id": 2, "customer": {"name": "Acme", "plan": "Team"}, "tags": []}
]
`;

/**
 * Many columns, long values, and timezone-bearing timestamps.
 *
 * Modelled on a real file that broke the Workspace layout: enough columns that the schema
 * chips and the preview table both exceed a laptop window, which is the condition the
 * responsive tests exist to pin down. Fixtures that are all small and tidy are how layout
 * bugs reach users.
 */
const WIDE_CSV = `import_id,status,current_stage,status_message,started_at,updated_at,processing_expires_at,processed_rows,imported_rows,failed_rows,source_uri,operator_email
2046581965196365824,processing,zip_coverage,Scanning ZIP coverage rows,2026-04-21 09:29:01.496974-04,2026-04-21 09:31:44.102233-04,2026-04-21 10:29:01.496974-04,184320,183991,329,s3://studio-imports/2026/04/21/batch-1238.parquet,operations-intake@example.com
2046581965196365825,complete,finalize,All rows imported successfully,2026-04-21 08:02:11.000001-04,2026-04-21 08:19:52.773100-04,2026-04-21 09:02:11.000001-04,942117,942117,0,s3://studio-imports/2026/04/21/batch-1237.parquet,operations-intake@example.com
2046581965196365826,failed,validate,Rejected: 12 rows missing a required postal code,2026-04-20 22:14:03.551000-04,2026-04-20 22:14:59.118000-04,2026-04-20 23:14:03.551000-04,12,0,12,s3://studio-imports/2026/04/20/batch-1199.parquet,nightly-loader@example.com
`;

/** Rows in the large fixture. Enough that a full scan is measurably slower than a preview. */
export const LARGE_FIXTURE_ROWS = 1_000_000;

export async function generateFixtures(root: string = defaultFixtureRoot()): Promise<FixturePaths> {
  const paths = fixturePaths(root);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  await writeFile(paths.ordersCsv, ORDERS_CSV, 'utf8');
  await writeFile(paths.quotedCsv, QUOTED_CSV, 'utf8');
  await writeFile(paths.raggedCsv, RAGGED_CSV, 'utf8');
  await writeFile(paths.mixedCsv, MIXED_CSV, 'utf8');
  await writeFile(paths.ordersTsv, ORDERS_CSV.replace(/,/g, '\t'), 'utf8');
  await writeFile(paths.notesNdjson, NOTES_NDJSON, 'utf8');
  await writeFile(paths.nestedJson, NESTED_JSON, 'utf8');
  await writeFile(paths.wideCsv, WIDE_CSV, 'utf8');

  await writeXlsx(paths.workbookXlsx, [
    {
      name: 'Orders',
      rows: [
        ['order_id', 'product', 'revenue_cents'],
        ['A-1042', 'Trail Hoodie', 8900],
        ['A-1043', 'Wool Beanie', 2400],
        ['A-1044', 'Summit Pack', 12900],
      ],
    },
    {
      name: 'Refunds',
      rows: [
        ['order_id', 'reason'],
        ['A-1044', 'damaged in transit'],
      ],
    },
  ]);

  // Parquet and SQLite are written by DuckDB itself, so the fixtures are exactly what the
  // engine under test produces and reads.
  const instance = await DuckDBInstance.create(':memory:', {
    extension_directory: process.env['DATERA_EXTENSION_DIR'] ?? extensionDirFromRepo(),
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  const conn = await instance.connect();

  await conn.run(
    `COPY (SELECT * FROM read_csv('${paths.ordersCsv.replace(/'/g, "''")}', auto_detect=true))
     TO '${paths.ordersParquet.replace(/'/g, "''")}' (FORMAT parquet)`,
  );

  await conn.run(
    `COPY (
       SELECT i AS id,
              'row-' || i AS label,
              CASE WHEN i % 7 = 0 THEN NULL ELSE i * 3 END AS value
       FROM range(${LARGE_FIXTURE_ROWS}) t(i)
     ) TO '${paths.largeParquet.replace(/'/g, "''")}' (FORMAT parquet)`,
  );

  await conn.run('LOAD sqlite_scanner');
  await conn.run(`ATTACH '${paths.customersSqlite.replace(/'/g, "''")}' AS sq (TYPE sqlite)`);
  await conn.run(`CREATE TABLE sq.customers (id VARCHAR, name VARCHAR, plan VARCHAR, ltv_cents BIGINT)`);
  await conn.run(
    `INSERT INTO sq.customers VALUES
      ('c-01','Northwind','Pro',1842000),
      ('c-02','Acme','Team',1411000),
      ('c-03','Globex','Free',0)`,
  );
  await conn.run(`CREATE TABLE sq.plans (plan VARCHAR, monthly_cents BIGINT)`);
  await conn.run(`INSERT INTO sq.plans VALUES ('Pro',4900),('Team',2900),('Free',0)`);
  await conn.run('DETACH sq');

  conn.closeSync();
  instance.closeSync();

  return paths;
}

function extensionDirFromRepo(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'vendor', 'duckdb-extensions');
}
