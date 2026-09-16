import type {
  AuthoredOperation,
  CreateOperationInput,
  OperationResult,
  SchemaGraph,
  AddSourceRequest,
  AskResult,
  BuildResult,
  SearchHit,
  ToolDefinition,
  ToolResult,
  ConnectConfig,
  ClientId,
  TraceRecord,
  TraceQuery,
  RetentionPolicy,
  Environment,
  EnvironmentStatus,
  Lifecycle,
  ApiEndpoint,
  NormalizationProposal,
  EnumProposal,
  Version,
  VersionDiff,
  WriteProposal,
  AppliedWrite,
  ExportResult,
  AuthoredRelationship,
  ColumnDefinition,
  EntityDefinition,
  ModelCatalogue,
  ModelDescriptor,
  RelationshipProposal,
  SourceDictionary,
  TouchedSummary,
  Dataset,
  EngineInfo,
  PreviewOptions,
  PreviewResult,
  QueryResult,
  Source,
  SourceSchema,
  SourceWithStatus,
} from '@datera/core';

/**
 * P1-16 — the one contract between the UI and the core.
 *
 * Shaped so a future implementation backed by HTTP against a remote Datera Server can
 * satisfy it without the UI changing. That is acceptance §12.10 — "the client runs
 * standalone, and the same UI drives a connected server" — and it is only achievable if
 * the UI is coupled to this interface rather than to in-process calls. Hence the
 * Promise-returning shape everywhere, including for things that are synchronous today.
 */
export interface DateraApi {
  engineInfo(): Promise<EngineInfo>;
  listDatasets(): Promise<readonly Dataset[]>;
  listSources(): Promise<readonly SourceWithStatus[]>;
  addSource(request: AddSourceRequest): Promise<readonly Source[]>;
  removeSource(id: string): Promise<void>;
  getSchema(sourceId: string): Promise<SourceSchema>;
  preview(sourceId: string, options?: PreviewOptions): Promise<PreviewResult>;
  query(datasetId: string, sql: string): Promise<QueryResult>;
  /** Opens the OS file picker. Host-provided: the core has no idea what a dialog is. */
  pickFiles(): Promise<readonly string[]>;
  listWorkbookSheets(path: string): Promise<readonly string[]>;

  // ---- Phase 2 -----------------------------------------------------------
  ask(datasetId: string, question: string, options?: { topK?: number }): Promise<AskResult>;
  listModels(): Promise<ModelCatalogue>;
  downloadBundledModel(modelId: string): Promise<void>;
  removeBundledModel(modelId: string): Promise<void>;
  warmBundledModel(): Promise<void>;
  /** Subscribe to download progress. Returns an unsubscribe function. */
  onBundledProgress(
    listener: (progress: { modelId: string; receivedBytes: number; totalBytes: number }) => void,
  ): () => void;
  setChatModel(model: ModelDescriptor): Promise<void>;
  setApiKey(provider: string, apiKey: string): Promise<void>;
  hasApiKey(provider: string): Promise<boolean>;
  clearApiKey(provider: string): Promise<void>;

  // ---- Phase 3 -----------------------------------------------------------
  draftDictionary(sourceId: string): Promise<SourceDictionary>;
  getDictionary(sourceId: string): Promise<SourceDictionary>;
  confirmColumn(sourceId: string, definition: ColumnDefinition): Promise<void>;
  confirmColumns(sourceId: string, definitions: readonly ColumnDefinition[]): Promise<void>;
  schemaGraph(datasetId: string): Promise<SchemaGraph>;
  confirmEntity(sourceId: string, definition: EntityDefinition): Promise<void>;
  detectRelationships(datasetId: string): Promise<readonly RelationshipProposal[]>;
  confirmRelationship(datasetId: string, proposal: RelationshipProposal): Promise<AuthoredRelationship>;
  listRelationships(datasetId?: string): Promise<readonly AuthoredRelationship[]>;
  createDataset(input: { id?: string; name: string; description?: string }): Promise<unknown>;
  explainTouched(datasetId: string, sql: string, rowsReturned?: number): Promise<TouchedSummary>;

  // ---- Phase 4 -----------------------------------------------------------
  setEmbeddingModel(model: ModelDescriptor): Promise<void>;
  buildEmbeddings(datasetId: string): Promise<BuildResult>;
  semanticSearch(datasetId: string, text: string, k?: number): Promise<readonly SearchHit[]>;
  embeddingStatus(datasetId: string): Promise<{ chunks: number; columns: readonly string[] }>;

  // ---- Phase 7 -----------------------------------------------------------
  listTools(): Promise<readonly ToolDefinition[]>;
  createOperation(input: CreateOperationInput): Promise<AuthoredOperation>;
  listOperations(datasetId?: string): Promise<readonly AuthoredOperation[]>;
  deleteOperation(id: string): Promise<void>;
  callOperation(
    datasetId: string, name: string, args?: Record<string, unknown>,
  ): Promise<OperationResult>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  connectConfig(client: ClientId, options?: { url?: string; token?: string }): Promise<ConnectConfig>;
  queryTraceLog(query: TraceQuery): Promise<readonly TraceRecord[]>;
  getTraceRetention(): Promise<RetentionPolicy>;
  setTraceRetention(policy: Partial<RetentionPolicy>): Promise<RetentionPolicy>;
  getTracePayloadCapture(): Promise<boolean>;
  setTracePayloadCapture(enabled: boolean): Promise<void>;
  pruneTraceLog(): Promise<number>;

  // ---- Phase 8 (client half only) ---------------------------------------
  listEnvironments(): Promise<readonly Environment[]>;
  environmentStatuses(): Promise<readonly EnvironmentStatus[]>;
  addEnvironment(input: { id: string; name: string; url: string; token?: string }): Promise<Environment>;
  removeEnvironment(id: string): Promise<void>;
  pushDataset(datasetId: string, environmentId: string): Promise<{ ok: true; environment: string }>;
  remoteQuery(environmentId: string, datasetId: string, sql: string): Promise<unknown>;

  // ---- Phase 9 -----------------------------------------------------------
  getLifecycle(): Promise<Lifecycle>;
  setLifecycle(lifecycle: Lifecycle): Promise<void>;
  resetLifecycle(): Promise<void>;

  // ---- grouping + API docs ----------------------------------------------
  moveSource(sourceId: string, targetDatasetId: string): Promise<Source>;
  renameDataset(datasetId: string, name: string): Promise<Dataset>;
  deleteDataset(datasetId: string): Promise<void>;
  apiEndpoints(): Promise<readonly ApiEndpoint[]>;

  // ---- Phase 5 -----------------------------------------------------------
  deriveDataset(datasetId: string, input: { name: string }): Promise<{ datasetId: string; tables: readonly string[] }>;
  proposeNormalization(sourceId: string): Promise<NormalizationProposal>;
  applyNormalization(datasetId: string, proposal: NormalizationProposal, input: { name: string }): Promise<{ datasetId: string; tables: readonly string[] }>;
  proposeEnums(sourceId: string): Promise<readonly EnumProposal[]>;
  saveVersion(datasetId: string, label: string): Promise<Version>;
  listVersions(datasetId: string): Promise<readonly Version[]>;
  diffVersions(fromId: string, toId: string): Promise<VersionDiff>;
  exportDataset(datasetId: string, directory: string, options?: { format?: 'parquet' | 'csv' }): Promise<ExportResult>;
  importDataset(directory: string): Promise<{ datasetId: string; tables: readonly string[] }>;
  pickDirectory(): Promise<string | null>;

  // ---- Phase 6 -----------------------------------------------------------
  canWrite(datasetId: string): Promise<boolean>;
  grantWrite(datasetId: string): Promise<void>;
  enableWrites(datasetId: string): Promise<{ datasetId: string; derived: boolean }>;
  revokeWrite(datasetId: string): Promise<void>;
  proposeWrite(datasetId: string, sql: string): Promise<WriteProposal>;
  proposeWriteFromQuestion(datasetId: string, instruction: string): Promise<WriteProposal>;
  confirmWrite(proposalId: string): Promise<AppliedWrite>;
  undoWrite(writeId: string): Promise<void>;
  listWrites(datasetId: string): Promise<readonly AppliedWrite[]>;
  listTables(datasetId: string): Promise<readonly string[]>;
}

/** IPC channel names. Exported so main and preload cannot drift apart silently. */
export const IPC = {
  engineInfo: 'datera:engineInfo',
  listDatasets: 'datera:listDatasets',
  listSources: 'datera:listSources',
  addSource: 'datera:addSource',
  removeSource: 'datera:removeSource',
  getSchema: 'datera:getSchema',
  preview: 'datera:preview',
  query: 'datera:query',
  pickFiles: 'datera:pickFiles',
  listWorkbookSheets: 'datera:listWorkbookSheets',
  ask: 'datera:ask',
  listModels: 'datera:listModels',
  downloadBundledModel: 'datera:downloadBundledModel',
  removeBundledModel: 'datera:removeBundledModel',
  warmBundledModel: 'datera:warmBundledModel',
  bundledProgress: 'datera:bundledProgress',
  setChatModel: 'datera:setChatModel',
  setApiKey: 'datera:setApiKey',
  hasApiKey: 'datera:hasApiKey',
  clearApiKey: 'datera:clearApiKey',
  draftDictionary: 'datera:draftDictionary',
  getDictionary: 'datera:getDictionary',
  confirmColumn: 'datera:confirmColumn',
  confirmColumns: 'datera:confirmColumns',
  schemaGraph: 'datera:schemaGraph',
  confirmEntity: 'datera:confirmEntity',
  detectRelationships: 'datera:detectRelationships',
  confirmRelationship: 'datera:confirmRelationship',
  listRelationships: 'datera:listRelationships',
  createDataset: 'datera:createDataset',
  explainTouched: 'datera:explainTouched',
  setEmbeddingModel: 'datera:setEmbeddingModel',
  buildEmbeddings: 'datera:buildEmbeddings',
  semanticSearch: 'datera:semanticSearch',
  embeddingStatus: 'datera:embeddingStatus',
  listTools: 'datera:listTools',
  createOperation: 'datera:createOperation',
  listOperations: 'datera:listOperations',
  deleteOperation: 'datera:deleteOperation',
  callOperation: 'datera:callOperation',
  callTool: 'datera:callTool',
  connectConfig: 'datera:connectConfig',
  queryTraceLog: 'datera:queryTraceLog',
  getTraceRetention: 'datera:getTraceRetention',
  setTraceRetention: 'datera:setTraceRetention',
  getTracePayloadCapture: 'datera:getTracePayloadCapture',
  setTracePayloadCapture: 'datera:setTracePayloadCapture',
  pruneTraceLog: 'datera:pruneTraceLog',
  listEnvironments: 'datera:listEnvironments',
  environmentStatuses: 'datera:environmentStatuses',
  addEnvironment: 'datera:addEnvironment',
  removeEnvironment: 'datera:removeEnvironment',
  pushDataset: 'datera:pushDataset',
  remoteQuery: 'datera:remoteQuery',
  getLifecycle: 'datera:getLifecycle',
  setLifecycle: 'datera:setLifecycle',
  resetLifecycle: 'datera:resetLifecycle',
  moveSource: 'datera:moveSource',
  renameDataset: 'datera:renameDataset',
  deleteDataset: 'datera:deleteDataset',
  apiEndpoints: 'datera:apiEndpoints',
  deriveDataset: 'datera:deriveDataset',
  proposeNormalization: 'datera:proposeNormalization',
  applyNormalization: 'datera:applyNormalization',
  proposeEnums: 'datera:proposeEnums',
  saveVersion: 'datera:saveVersion',
  listVersions: 'datera:listVersions',
  diffVersions: 'datera:diffVersions',
  exportDataset: 'datera:exportDataset',
  importDataset: 'datera:importDataset',
  pickDirectory: 'datera:pickDirectory',
  canWrite: 'datera:canWrite',
  grantWrite: 'datera:grantWrite',
  enableWrites: 'datera:enableWrites',
  revokeWrite: 'datera:revokeWrite',
  proposeWrite: 'datera:proposeWrite',
  proposeWriteFromQuestion: 'datera:proposeWriteFromQuestion',
  confirmWrite: 'datera:confirmWrite',
  undoWrite: 'datera:undoWrite',
  listWrites: 'datera:listWrites',
  listTables: 'datera:listTables',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * How an error crosses the IPC boundary.
 *
 * Electron serialises a thrown Error down to its message, which would lose the
 * `DateraError` code — and the UI needs the code to tell "this is read-only" from "that
 * file moved". So errors are marshalled explicitly rather than thrown across.
 */
export interface SerialisedError {
  readonly __dateraError: true;
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export function isSerialisedError(value: unknown): value is SerialisedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __dateraError?: unknown }).__dateraError === true
  );
}
