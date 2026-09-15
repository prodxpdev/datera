import type {
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

  // ---- Phase 2 -----------------------------------------------------------
  ask(datasetId: string, question: string, options?: { topK?: number }): Promise<AskResult>;
  listModels(): Promise<ModelCatalogue>;
  setChatModel(model: ModelDescriptor): Promise<void>;
  setApiKey(provider: string, apiKey: string): Promise<void>;
  hasApiKey(provider: string): Promise<boolean>;
  clearApiKey(provider: string): Promise<void>;

  // ---- Phase 3 -----------------------------------------------------------
  draftDictionary(sourceId: string): Promise<SourceDictionary>;
  getDictionary(sourceId: string): Promise<SourceDictionary>;
  confirmColumn(sourceId: string, definition: ColumnDefinition): Promise<void>;
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
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  connectConfig(client: ClientId, options?: { url?: string; token?: string }): Promise<ConnectConfig>;
  queryTraceLog(query: TraceQuery): Promise<readonly TraceRecord[]>;
  getTraceRetention(): Promise<RetentionPolicy>;
  setTraceRetention(policy: Partial<RetentionPolicy>): Promise<RetentionPolicy>;
  getTracePayloadCapture(): Promise<boolean>;
  setTracePayloadCapture(enabled: boolean): Promise<void>;
  pruneTraceLog(): Promise<number>;
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
  ask: 'datera:ask',
  listModels: 'datera:listModels',
  setChatModel: 'datera:setChatModel',
  setApiKey: 'datera:setApiKey',
  hasApiKey: 'datera:hasApiKey',
  clearApiKey: 'datera:clearApiKey',
  draftDictionary: 'datera:draftDictionary',
  getDictionary: 'datera:getDictionary',
  confirmColumn: 'datera:confirmColumn',
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
  callTool: 'datera:callTool',
  connectConfig: 'datera:connectConfig',
  queryTraceLog: 'datera:queryTraceLog',
  getTraceRetention: 'datera:getTraceRetention',
  setTraceRetention: 'datera:setTraceRetention',
  getTracePayloadCapture: 'datera:getTracePayloadCapture',
  setTracePayloadCapture: 'datera:setTracePayloadCapture',
  pruneTraceLog: 'datera:pruneTraceLog',
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
