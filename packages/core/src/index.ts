/**
 * @datera/core — the portable Datera engine.
 *
 * This package has no desktop- or server-specific dependencies (invariant §1.7), and a
 * test enforces that (see the core purity guard). Hosts supply a DuckDB driver and the
 * four ports; everything else is here.
 */

export { Datera } from './datera.js';
export type {
  DateraOptions,
  EngineInfo,
  PreviewOptions,
  PreviewResult,
  QueryResult,
} from './datera.js';

export { DateraError, asDateraError } from './errors.js';
export type { DateraErrorCode } from './errors.js';

export { Engine } from './engine/engine.js';
export type { EngineOpenOptions, UserQueryResult } from './engine/engine.js';
export { assertReadOnlySql, READ_ONLY_STATEMENT_KINDS } from './engine/read-only.js';
export type { ReadOnlyCheck } from './engine/read-only.js';
export {
  REQUIRED_EXTENSIONS,
  loadRequiredExtensions,
  readLoadedExtensions,
  assertExtensionLoaded,
} from './engine/extensions.js';
export type { ExtensionStatus, RequiredExtension } from './engine/extensions.js';
export { quoteIdent, quoteLiteral, qualified, slugifyIdent } from './engine/sql.js';

export type {
  Dataset,
} from './datasets/types.js';
export {
  DEFAULT_DATASET_ID,
  DEFAULT_DATASET_NAME,
  DEFAULT_DATASET_SCHEMA,
  DEFAULT_DATASET_DESCRIPTION,
} from './datasets/types.js';

export type {
  Source,
  SourceWithStatus,
  SourceStatus,
  SourceKind,
  FileSourceKind,
  DatabaseSourceKind,
  SourceDetection,
  AddSourceRequest,
  AddFileSourceRequest,
  AddSqliteSourceRequest,
  AddDatabaseSourceRequest,
} from './sources/types.js';
export {
  FILE_SOURCE_KINDS,
  DATABASE_SOURCE_KINDS,
  isFileSourceKind,
} from './sources/types.js';
export { inferFileKind } from './sources/files.js';
export { buildAttachStatement, redactedOrigin, defaultPort, redactCredentials } from './sources/attachments.js';
export type { DatabaseConnectionParams } from './sources/attachments.js';

export type { SourceSchema, ColumnSchema } from './schema/introspect.js';
export { introspectRelation } from './schema/introspect.js';
export {
  createAuthoredTable,
  dropAuthoredTable,
  normaliseType,
  assertAuthorableName,
} from './datasets/authoring.js';
export type {
  AuthoredTable,
  AuthoredColumn,
  AuthoredRelationship,
} from './datasets/authoring.js';
export type { InferenceNote, InferenceVerdict } from './schema/inference.js';

export {
  workspacePaths,
  WORKSPACE_DATABASE,
  WORKSPACE_MANIFEST,
  WORKSPACE_FORMAT_VERSION,
} from './workspace/workspace.js';
export type { WorkspaceManifest, WorkspacePaths } from './workspace/workspace.js';

export * from './ports/index.js';
