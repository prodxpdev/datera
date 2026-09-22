import type { Engine } from '../engine/engine.js';
import { qualified, quoteLiteral } from '../engine/sql.js';
import type { FileSystemPort } from '../ports/filesystem.js';
import type { Dataset } from '../datasets/types.js';
import type { SourceDictionary } from '../dictionary/types.js';
import type { AuthoredRelationship } from '../datasets/authoring.js';
import { joinPath } from '../util/paths.js';
import { tablesIn } from './versions.js';

/**
 * Export — invariant §1.8, "delete Datera and your artifact still runs".
 *
 * The guarantee is not "you can get your rows back", which every tool claims. It is that
 * **everything** leaves: the data, the schema, the dictionary, the relationships and the
 * dataset definition, in formats that need no Datera to read. Parquet and CSV are
 * readable by pandas, DuckDB, Spark and a spreadsheet; the manifest is plain JSON.
 *
 * The round trip is tested (§12.11) rather than asserted, because a portability promise
 * nobody executes is one that quietly stops being true.
 */

export type ExportFormat = 'parquet' | 'csv';

export interface ExportManifest {
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly exportedBy: string;
  readonly dataset: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
  readonly tables: readonly {
    readonly name: string;
    readonly file: string;
    readonly rowCount: number;
    readonly columns: readonly { name: string; type: string }[];
  }[];
  readonly dictionaries: readonly SourceDictionary[];
  readonly relationships: readonly AuthoredRelationship[];
  /**
   * DDL for the tables, so the schema is reconstructable by anything that speaks SQL —
   * including by hand, and including without reading the manifest at all.
   */
  readonly ddl: readonly string[];
}

export const MANIFEST_FILE = 'datera-export.json';

export interface ExportResult {
  readonly directory: string;
  readonly files: readonly string[];
  readonly manifest: ExportManifest;
}

export async function exportDataset(options: {
  readonly engine: Engine;
  readonly fs: FileSystemPort;
  readonly dataset: Dataset;
  readonly directory: string;
  readonly format: ExportFormat;
  readonly dictionaries: readonly SourceDictionary[];
  readonly relationships: readonly AuthoredRelationship[];
  readonly now: () => Date;
  readonly appVersion: string;
}): Promise<ExportResult> {
  await options.fs.mkdirp(options.directory);

  const tables = await tablesIn(options.engine, options.dataset.schemaName);
  const files: string[] = [];
  const entries: ExportManifest['tables'][number][] = [];
  const ddl: string[] = [];

  for (const table of tables) {
    const file = `${table}.${options.format}`;
    const target = joinPath(options.directory, file);

    // COPY ... TO is a write, and it goes through executeInternal rather than the guarded
    // user path — Datera is writing to a directory the user chose, not to a source.
    const copyOptions = options.format === 'parquet' ? `(FORMAT parquet)` : `(FORMAT csv, HEADER)`;
    await options.engine.executeInternal(
      `COPY (SELECT * FROM ${qualified(options.dataset.schemaName, table)}) TO ${quoteLiteral(target)} ${copyOptions}`,
    );
    files.push(target);

    const described = await options.engine.executeInternal(
      `DESCRIBE ${qualified(options.dataset.schemaName, table)}`,
    );
    const columns = described.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) }));

    const counted = await options.engine.executeInternal(
      `SELECT count(*) FROM ${qualified(options.dataset.schemaName, table)}`,
    );

    entries.push({
      name: table,
      file,
      rowCount: Number(counted.rows[0]?.[0] ?? 0),
      columns,
    });

    ddl.push(
      `CREATE TABLE ${JSON.stringify(table)} (${columns
        .map((c) => `${JSON.stringify(c.name)} ${c.type}`)
        .join(', ')});`,
    );
  }

  const manifest: ExportManifest = {
    formatVersion: 1,
    exportedAt: options.now().toISOString(),
    exportedBy: `Datera ${options.appVersion}`,
    dataset: {
      id: options.dataset.id,
      name: options.dataset.name,
      description: options.dataset.description,
    },
    tables: entries,
    dictionaries: options.dictionaries,
    relationships: options.relationships,
    ddl,
  };

  const manifestPath = joinPath(options.directory, MANIFEST_FILE);
  await options.fs.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  files.push(manifestPath);

  // A plain .sql file too, so the schema is legible without parsing anything.
  const ddlPath = joinPath(options.directory, 'schema.sql');
  await options.fs.writeTextFile(ddlPath, `${ddl.join('\n')}\n`);
  files.push(ddlPath);

  return { directory: options.directory, files, manifest };
}

export function parseManifest(raw: string): ExportManifest {
  const parsed = JSON.parse(raw) as ExportManifest;
  if (parsed.formatVersion !== 1) {
    throw new Error(`Unsupported export format version ${String(parsed.formatVersion)}`);
  }
  return parsed;
}
