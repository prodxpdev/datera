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

// -------------------------------------------------------- dictionary (§4)
export type {
  SourceDictionary, ColumnDefinition, EntityDefinition, DefinitionState,
  ColumnRole, Sensitivity, EnumValueMeaning,
} from './dictionary/types.js';
export { confirmedOnly, UNDEFINED_ENTITY } from './dictionary/types.js';
export { draftDictionary } from './dictionary/draft.js';
export { detectRelationships } from './datasets/detect-relationships.js';
export type { RelationshipProposal } from './datasets/detect-relationships.js';

export {
  workspacePaths,
  WORKSPACE_DATABASE,
  WORKSPACE_MANIFEST,
  WORKSPACE_FORMAT_VERSION,
} from './workspace/workspace.js';
export type { WorkspaceManifest, WorkspacePaths } from './workspace/workspace.js';

export * from './ports/index.js';

// ---------------------------------------------------------------- models (§9)
export type {
  ModelDescriptor, ModelTier, ModelRole, Locality,
  ChatModel, ChatMessage, ChatRequest, ChatResponse, TokenUsage, Pricing,
} from './models/types.js';
export { describeModel, providerLabel, computeCost, estimateTokens, FREE } from './models/types.js';
export { OpenAICompatibleChatModel } from './models/openai-compatible.js';
export type { OpenAICompatibleOptions } from './models/openai-compatible.js';
export { AnthropicChatModel } from './models/anthropic.js';
export type { AnthropicOptions } from './models/anthropic.js';
export { detectLocalRuntimes, DEFAULT_CANDIDATES } from './models/detect.js';
export type { DetectedRuntime, RuntimeCandidate, DetectOptions } from './models/detect.js';
export { pricingFor } from './models/pricing.js';
export { redactSecrets } from './models/redact.js';

// ------------------------------------------------------------- query (§5)
export type { AskResult, Citations } from './query/ask.js';
export type { Trace, TraceStage, StageKind, Route } from './query/trace.js';
export { buildSchemaContext, summariseSchemas, SYSTEM_PROMPT } from './query/context.js';
export { extractSql } from './query/sql-extract.js';
export { assertWithinDataset, extractTableReferences } from './query/scope.js';
export { summariseTouched } from './query/touched.js';
export { completionsAt, referencedTables, starterSql } from './query/schema-graph.js';
export type {
  CompletionItem, CompletionKind, CompletionResult,
  GraphColumn, GraphRelationship, GraphTable, SchemaGraph,
} from './query/schema-graph.js';
export { routeQuestion } from './query/router.js';
export type { RouteDecision } from './query/router.js';
export { OpenAICompatibleEmbeddingModel, looksLikeEmbeddingModel } from './models/embeddings.js';
export type { EmbeddingModel, EmbeddingOptions } from './models/embeddings.js';
export type { SearchHit, StoredChunk } from './semantic/store.js';
export type { BuildResult } from './semantic/build.js';

// ---------------------------------------------- copy-on-write (§1.2, §1.8)
export type { Version, VersionDiff, RowCountChange, ColumnChange } from './cow/versions.js';
export type { ExportManifest, ExportResult, ExportFormat } from './cow/export.js';
export { MANIFEST_FILE } from './cow/export.js';
export type { DatasetKind } from './datasets/types.js';
export type { NormalizationProposal, EntityProposal, EnumProposal } from './cow/normalize.js';

// ------------------------------------------------------------- writes (§6)
export type { WriteProposal, AppliedWrite, RowChange, WriteKind } from './writes/writes.js';

// -------------------------------------------------------- serve (§8, §8a)
export type { ToolDefinition, ToolSchema, ToolContext } from './serve/tools.js';
export { toolsFor, toolSuffix } from './serve/tools.js';
export type { ConnectConfig, ClientId } from './serve/configs.js';
export { API_ENDPOINTS, apiEndpointsByGroup } from './serve/api-spec.js';
export type { ApiEndpoint, ApiParameter } from './serve/api-spec.js';
export type { TraceRecord, TraceQuery, RetentionPolicy, TraceOrigin } from './serve/trace-log.js';
export { DEFAULT_RETENTION } from './serve/trace-log.js';
export type { ToolResult } from './datera.js';

// ------------------------------------------------- environments (§10, §12.10)
export type { Environment, EnvironmentStatus, EnvironmentKind } from './environments/types.js';
export { LOCAL_ENVIRONMENT_ID, environmentTokenKey } from './environments/types.js';
export { RemoteDatera } from './environments/remote.js';
export type { RemoteQueryResult } from './environments/remote.js';

// ----------------------------------------------------------- teaching (§11.9)
export { DEFAULT_LIFECYCLE, validateLifecycle } from './teaching/lifecycle.js';
export { deriveLifecycle } from './teaching/derive.js';
export type { Lifecycle, LifecycleLayer, LifecycleTransform, LifecycleLane } from './teaching/lifecycle.js';
export type { TouchedSummary, TouchedTable, TouchedColumn, ColumnRoleInQuery } from './query/touched.js';
export type { TableReference, ScopeCheck } from './query/scope.js';
export type { ModelCatalogue } from './datera.js';
export { apiKeySecretName } from './datera.js';
