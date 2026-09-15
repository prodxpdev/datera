/**
 * Source — the first of the three nouns (spec §3). An immutable input Datera reads
 * read-only and never mutates.
 *
 * Resist a fourth noun (spec §13). Dataset and Version are the other two; everything else
 * is an attribute of one of them.
 */

export type FileSourceKind = 'csv' | 'tsv' | 'json' | 'parquet' | 'xlsx';
export type DatabaseSourceKind = 'sqlite' | 'postgres' | 'mysql';
export type SourceKind = FileSourceKind | DatabaseSourceKind;

export const FILE_SOURCE_KINDS: readonly FileSourceKind[] = ['csv', 'tsv', 'json', 'parquet', 'xlsx'];
export const DATABASE_SOURCE_KINDS: readonly DatabaseSourceKind[] = ['sqlite', 'postgres', 'mysql'];

export function isFileSourceKind(kind: SourceKind): kind is FileSourceKind {
  return (FILE_SOURCE_KINDS as readonly string[]).includes(kind);
}

/** Evidence for how a source was parsed. A transparency surface, not internal trivia (spec §1.4). */
export interface SourceDetection {
  /** e.g. 'DuckDB CSV sniffer', 'read_xlsx', 'sqlite_scanner ATTACH (READ_ONLY)'. */
  readonly method: string;
  /** Sniffed parse settings — delimiter, quote, header, and so on. Shown verbatim. */
  readonly settings: Readonly<Record<string, string>>;
  /**
   * Things the user needs told about how this file was read.
   *
   * Not errors — the source connected. These are the cases where the parse *succeeded*
   * but probably is not what the user meant, which is the failure mode a transparency
   * tool exists to catch (spec §1.4). Silence here would be the bug.
   */
  readonly warnings?: readonly string[] | undefined;
}

export interface Source {
  readonly id: string;
  readonly datasetId: string;
  /** Display name and the view name inside the dataset schema. */
  readonly name: string;
  readonly kind: SourceKind;
  /** Absolute file path, or a redacted DSN for a database. Never contains a password. */
  readonly origin: string;
  /** For database sources: the table this source projects. */
  readonly table?: string | undefined;
  /** For database sources: the DuckDB ATTACH alias shared by every source from one connection. */
  readonly attachmentAlias?: string | undefined;
  /** For database sources: the SecretStore key holding the credential. Never the credential. */
  readonly secretKey?: string | undefined;
  readonly detection: SourceDetection;
  readonly addedAt: string;
}

export type SourceAvailability = 'available' | 'unavailable';

export interface SourceStatus {
  readonly availability: SourceAvailability;
  /** Present when unavailable — the reason, in words a user can act on. */
  readonly reason?: string | undefined;
}

export interface SourceWithStatus extends Source {
  readonly status: SourceStatus;
}

/** A file on disk to connect. Kind is inferred from the extension unless given. */
export interface AddFileSourceRequest {
  readonly type: 'file';
  readonly path: string;
  readonly name?: string | undefined;
  readonly kind?: FileSourceKind | undefined;
  readonly datasetId?: string | undefined;
  /** For .xlsx: which sheet. Omitted means every sheet becomes its own source. */
  readonly sheet?: string | undefined;
}

/** A SQLite database file to attach read-only. Every table becomes a source. */
export interface AddSqliteSourceRequest {
  readonly type: 'sqlite';
  readonly path: string;
  readonly namePrefix?: string | undefined;
  readonly datasetId?: string | undefined;
  readonly tables?: readonly string[] | undefined;
}

/** A live Postgres or MySQL database to attach read-only. */
export interface AddDatabaseSourceRequest {
  readonly type: 'postgres' | 'mysql';
  readonly host: string;
  readonly port?: number | undefined;
  readonly database: string;
  readonly user: string;
  /** Written straight to the SecretStore and never retained in the catalog (decision D-06). */
  readonly password?: string | undefined;
  readonly namePrefix?: string | undefined;
  readonly datasetId?: string | undefined;
  readonly tables?: readonly string[] | undefined;
}

export type AddSourceRequest = AddFileSourceRequest | AddSqliteSourceRequest | AddDatabaseSourceRequest;
