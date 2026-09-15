import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the renderer and the core.
 *
 * It deliberately exposes **envelope-returning** functions rather than functions that
 * throw. `contextBridge` sanitises values crossing the world boundary, and that includes
 * stripping non-standard own properties off a thrown Error — so a `DateraError` thrown
 * here would arrive in the renderer with its `code` silently gone, and the UI could no
 * longer tell "read-only violation" from "file moved".
 *
 * So the failure is carried as data, and `renderer/api.ts` turns it back into a typed
 * error on the other side, in the main world, where the code survives.
 *
 * Note also that this exposes a fixed set of named functions rather than a general
 * `invoke(channel, ...args)`. A generic escape hatch would undo most of the value of
 * isolating the renderer in the first place.
 */
const IPC = {
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
} as const;

const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('dateraBridge', {
  engineInfo: () => call(IPC.engineInfo),
  listDatasets: () => call(IPC.listDatasets),
  listSources: () => call(IPC.listSources),
  addSource: (request: unknown) => call(IPC.addSource, request),
  removeSource: (id: string) => call(IPC.removeSource, id),
  getSchema: (sourceId: string) => call(IPC.getSchema, sourceId),
  preview: (sourceId: string, options?: unknown) => call(IPC.preview, sourceId, options),
  query: (datasetId: string, sql: string) => call(IPC.query, datasetId, sql),
  pickFiles: () => call(IPC.pickFiles),
  ask: (datasetId: string, question: string, opts?: unknown) => call(IPC.ask, datasetId, question, opts),
  listModels: () => call(IPC.listModels),
  setChatModel: (model: unknown) => call(IPC.setChatModel, model),
  setApiKey: (provider: string, key: string) => call(IPC.setApiKey, provider, key),
  hasApiKey: (provider: string) => call(IPC.hasApiKey, provider),
  clearApiKey: (provider: string) => call(IPC.clearApiKey, provider),
  draftDictionary: (sourceId: string) => call(IPC.draftDictionary, sourceId),
  getDictionary: (sourceId: string) => call(IPC.getDictionary, sourceId),
  confirmColumn: (sourceId: string, d: unknown) => call(IPC.confirmColumn, sourceId, d),
  confirmEntity: (sourceId: string, d: unknown) => call(IPC.confirmEntity, sourceId, d),
  detectRelationships: (datasetId: string) => call(IPC.detectRelationships, datasetId),
  confirmRelationship: (datasetId: string, p: unknown) => call(IPC.confirmRelationship, datasetId, p),
  listRelationships: (datasetId?: string) => call(IPC.listRelationships, datasetId),
  createDataset: (input: unknown) => call(IPC.createDataset, input),
  explainTouched: (datasetId: string, sql: string, rows?: number) => call(IPC.explainTouched, datasetId, sql, rows),
  setEmbeddingModel: (m: unknown) => call(IPC.setEmbeddingModel, m),
  buildEmbeddings: (datasetId: string) => call(IPC.buildEmbeddings, datasetId),
  semanticSearch: (datasetId: string, text: string, k?: number) => call(IPC.semanticSearch, datasetId, text, k),
  embeddingStatus: (datasetId: string) => call(IPC.embeddingStatus, datasetId),
  listTools: () => call(IPC.listTools),
  callTool: (name: string, args: unknown) => call(IPC.callTool, name, args),
  connectConfig: (client: string, opts?: unknown) => call(IPC.connectConfig, client, opts),
  queryTraceLog: (query: unknown) => call(IPC.queryTraceLog, query),
  getTraceRetention: () => call(IPC.getTraceRetention),
  setTraceRetention: (policy: unknown) => call(IPC.setTraceRetention, policy),
  getTracePayloadCapture: () => call(IPC.getTracePayloadCapture),
  setTracePayloadCapture: (enabled: boolean) => call(IPC.setTracePayloadCapture, enabled),
  pruneTraceLog: () => call(IPC.pruneTraceLog),
  listEnvironments: () => call(IPC.listEnvironments),
  environmentStatuses: () => call(IPC.environmentStatuses),
  addEnvironment: (input: unknown) => call(IPC.addEnvironment, input),
  removeEnvironment: (id: string) => call(IPC.removeEnvironment, id),
  pushDataset: (datasetId: string, envId: string) => call(IPC.pushDataset, datasetId, envId),
  remoteQuery: (envId: string, datasetId: string, sql: string) => call(IPC.remoteQuery, envId, datasetId, sql),
  getLifecycle: () => call(IPC.getLifecycle),
  setLifecycle: (lifecycle: unknown) => call(IPC.setLifecycle, lifecycle),
  resetLifecycle: () => call(IPC.resetLifecycle),
  moveSource: (sourceId: string, target: string) => call(IPC.moveSource, sourceId, target),
  renameDataset: (id: string, name: string) => call(IPC.renameDataset, id, name),
  deleteDataset: (id: string) => call(IPC.deleteDataset, id),
  apiEndpoints: () => call(IPC.apiEndpoints),
});
