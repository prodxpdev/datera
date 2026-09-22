import { DateraError } from '../errors.js';
import type { Engine } from '../engine/engine.js';
import { quoteLiteral } from '../engine/sql.js';
import { extname } from '../util/paths.js';
import type { FileSourceKind, SourceDetection } from './types.js';

const EXTENSION_TO_KIND: Readonly<Record<string, FileSourceKind>> = {
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  txt: 'csv',
  json: 'json',
  ndjson: 'json',
  jsonl: 'json',
  parquet: 'parquet',
  pq: 'parquet',
  xlsx: 'xlsx',
};

/** Legacy formats we deliberately refuse, with the fix in the message (decision D-07). */
const REFUSED_EXTENSIONS: Readonly<Record<string, string>> = {
  xls: 'Legacy .xls workbooks are not supported. Re-save the file as .xlsx and connect that.',
  xlsm: 'Macro-enabled .xlsm workbooks are not supported. Re-save the file as .xlsx and connect that.',
  md: 'Markdown tables are not a v1 source format (spec §3). Export the table as CSV and connect that.',
  xml: 'XML is not a v1 source format (spec §3). Convert it to JSON or CSV and connect that.',
};

export function inferFileKind(path: string): FileSourceKind {
  const ext = extname(path);
  const refusal = REFUSED_EXTENSIONS[ext];
  if (refusal !== undefined) {
    throw new DateraError('UNSUPPORTED_FORMAT', refusal, { path, extension: ext });
  }
  const kind = EXTENSION_TO_KIND[ext];
  if (kind === undefined) {
    throw new DateraError(
      'UNSUPPORTED_FORMAT',
      `Datera does not recognise ".${ext}". Supported: CSV, TSV, JSON, Parquet, XLSX, SQLite, and live Postgres/MySQL.`,
      { path, extension: ext },
    );
  }
  return kind;
}

export interface FileReadPlan {
  /** A table expression that reads the file. Always read-only by construction. */
  readonly expression: string;
  readonly detection: SourceDetection;
}

/**
 * Decide how to read a file, and capture the evidence for that decision.
 *
 * The detection settings are not decoration: "how did it parse my file" is one of the
 * questions the transparency drawer has to answer (spec §1.4, §5), and a wrong delimiter
 * guess is the most common reason a CSV looks like nonsense.
 */
export async function planFileRead(
  engine: Engine,
  kind: FileSourceKind,
  path: string,
  options: { readonly sheet?: string | undefined } = {},
): Promise<FileReadPlan> {
  const literal = quoteLiteral(path);

  switch (kind) {
    case 'csv':
    case 'tsv': {
      const sniff = await sniffCsv(engine, path);
      return {
        expression: `read_csv(${literal}, auto_detect=true)`,
        detection: {
          method: 'DuckDB CSV sniffer',
          settings: sniff,
          warnings: csvWarnings(sniff),
        },
      };
    }
    case 'json':
      return {
        expression: `read_json(${literal}, auto_detect=true)`,
        detection: {
          method: 'read_json (auto)',
          settings: { format: 'auto — newline-delimited and array-of-objects both handled' },
        },
      };
    case 'parquet':
      return {
        expression: `read_parquet(${literal})`,
        detection: {
          method: 'read_parquet',
          settings: { schema: 'read from the Parquet footer — no inference needed' },
        },
      };
    case 'xlsx': {
      const sheetArg = options.sheet === undefined ? '' : `, sheet=${quoteLiteral(options.sheet)}`;
      return {
        expression: `read_xlsx(${literal}${sheetArg})`,
        detection: {
          method: 'read_xlsx (excel extension)',
          settings: {
            sheet: options.sheet ?? 'the workbook default (first sheet)',
            note:
              options.sheet === undefined
                ? 'Only the default sheet was read. Connect the file again with an explicit sheet name to add another sheet as its own source.'
                : 'Explicit sheet.',
          },
        },
      };
    }
  }
}

/**
 * Detect the sniffer giving up.
 *
 * When a CSV has a row with more fields than the header, DuckDB's sniffer can abandon the
 * real delimiter and fall back to one that yields a single column — so the file loads
 * "successfully" as one VARCHAR column containing whole lines. Nothing errors, and the
 * data is nonsense.
 *
 * This is precisely the failure a transparency tool must not pass over in silence, so it
 * is surfaced as a warning on the source rather than left for the user to notice when an
 * answer comes out wrong three steps later.
 */
function csvWarnings(settings: Readonly<Record<string, string>>): readonly string[] {
  const warnings: string[] = [];
  const names = sniffedColumnNames(settings['Columns']);
  if (names === null) return warnings;

  const only = names.length === 1 ? names[0] ?? '' : '';
  if (names.length === 1 && /[,;\t|]/.test(only)) {
    warnings.push(
      `Read as a single column named "${only}". The delimiter was detected as ` +
        `"${settings['Delimiter'] ?? '?'}", which is probably wrong — this usually means a row ` +
        `has more fields than the header, so the sniffer gave up and fell back. Check the file, ` +
        `or re-connect specifying the delimiter explicitly.`,
    );
  }
  return warnings;
}

/**
 * Column names out of the sniffer's `Columns` value.
 *
 * Tolerant of two shapes on purpose. DuckDB returns a LIST of STRUCTs, and what reaches
 * here depends on the driver's value conversion: a JSON-converting driver yields real
 * JSON, while one that stringifies rich DuckDB values (as the Node driver does) yields
 * DuckDB's own struct text, `[{'name': 'x', 'type': 'VARCHAR'}]` — single-quoted, and not
 * valid JSON. Both are legitimate, and a warning that silently stopped firing because a
 * driver changed its conversion would be worse than no warning at all.
 */
function sniffedColumnNames(raw: string | undefined): readonly string[] | null {
  if (raw === undefined) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const names = parsed
        .map((e) => (typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined))
        .filter((n): n is string => typeof n === 'string');
      if (names.length > 0) return names;
    }
  } catch {
    // Not JSON — fall through to DuckDB's struct text.
  }

  const names: string[] = [];
  const pattern = /'name':\s*'(.*?)'\s*,\s*'type'/gs;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names.length > 0 ? names : null;
}

/**
 * Ask DuckDB's own sniffer what it sees. Returns the settings verbatim, including the
 * fully-explicit `read_csv(...)` call it would generate, so a user can reproduce the
 * exact parse by hand.
 */
async function sniffCsv(engine: Engine, path: string): Promise<Record<string, string>> {
  try {
    const result = await engine.executeInternal(`SELECT * FROM sniff_csv(${quoteLiteral(path)})`);
    const settings: Record<string, string> = {};
    const row = result.rows[0];
    if (row === undefined) return { note: 'The sniffer returned no result.' };
    result.columns.forEach((col, i) => {
      const value = row[i];
      if (value === null || value === undefined) return;
      settings[col.name] = typeof value === 'string' ? value : JSON.stringify(value);
    });
    return settings;
  } catch (e) {
    // A file the sniffer cannot read will fail again, more informatively, at view creation.
    return { note: `The CSV sniffer could not analyse this file: ${e instanceof Error ? e.message : String(e)}` };
  }
}
