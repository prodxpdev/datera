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
  ask: (datasetId: string, question: string) => call(IPC.ask, datasetId, question),
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
});
