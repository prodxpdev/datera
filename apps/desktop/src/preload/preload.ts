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
  downloadBundledModel: (id: string) => call(IPC.downloadBundledModel, id),
  removeBundledModel: (id: string) => call(IPC.removeBundledModel, id),
  warmBundledModel: () => call(IPC.warmBundledModel),
  setChatModel: (model: unknown) => call(IPC.setChatModel, model),
  setApiKey: (provider: string, key: string) => call(IPC.setApiKey, provider, key),
  hasApiKey: (provider: string) => call(IPC.hasApiKey, provider),
  clearApiKey: (provider: string) => call(IPC.clearApiKey, provider),
  draftDictionary: (sourceId: string) => call(IPC.draftDictionary, sourceId),
  getDictionary: (sourceId: string) => call(IPC.getDictionary, sourceId),
  confirmColumn: (sourceId: string, d: unknown) => call(IPC.confirmColumn, sourceId, d),
  confirmColumns: (sourceId: string, d: unknown) => call(IPC.confirmColumns, sourceId, d),
  schemaGraph: (datasetId: string) => call(IPC.schemaGraph, datasetId),
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
  createOperation: (input: unknown) => call(IPC.createOperation, input),
  listOperations: (datasetId?: string) => call(IPC.listOperations, datasetId),
  deleteOperation: (id: string) => call(IPC.deleteOperation, id),
  callOperation: (datasetId: string, name: string, args?: unknown) =>
    call(IPC.callOperation, datasetId, name, args),
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
  deriveDataset: (id: string, input: unknown) => call(IPC.deriveDataset, id, input),
  proposeNormalization: (sourceId: string) => call(IPC.proposeNormalization, sourceId),
  applyNormalization: (id: string, p: unknown, input: unknown) => call(IPC.applyNormalization, id, p, input),
  proposeEnums: (sourceId: string) => call(IPC.proposeEnums, sourceId),
  saveVersion: (id: string, label: string) => call(IPC.saveVersion, id, label),
  listVersions: (id: string) => call(IPC.listVersions, id),
  diffVersions: (a: string, b: string) => call(IPC.diffVersions, a, b),
  exportDataset: (id: string, dir: string, opts?: unknown) => call(IPC.exportDataset, id, dir, opts),
  importDataset: (dir: string) => call(IPC.importDataset, dir),
  pickDirectory: () => call(IPC.pickDirectory),
  canWrite: (id: string) => call(IPC.canWrite, id),
  grantWrite: (id: string) => call(IPC.grantWrite, id),
  enableWrites: (id: string) => call(IPC.enableWrites, id),
  revokeWrite: (id: string) => call(IPC.revokeWrite, id),
  proposeWrite: (id: string, sql: string) => call(IPC.proposeWrite, id, sql),
  proposeWriteFromQuestion: (id: string, q: string) => call(IPC.proposeWriteFromQuestion, id, q),
  confirmWrite: (proposalId: string) => call(IPC.confirmWrite, proposalId),
  undoWrite: (writeId: string) => call(IPC.undoWrite, writeId),
  listWrites: (id: string) => call(IPC.listWrites, id),
  listTables: (id: string) => call(IPC.listTables, id),

  /**
   * Download progress, pushed from the main process.
   *
   * A subscription rather than a promise: a two-gigabyte download with no visible
   * progress is indistinguishable from a hang. The listener is wrapped so the renderer
   * never receives the Electron event object — only the payload — because handing a
   * sandboxed page an IPC event is handing it a sender it should not have.
   */
  onBundledProgress: (listener: (progress: unknown) => void) => {
    const wrapped = (_event: unknown, progress: unknown): void => listener(progress);
    ipcRenderer.on(IPC.bundledProgress, wrapped);
    return () => ipcRenderer.removeListener(IPC.bundledProgress, wrapped);
  },
});
