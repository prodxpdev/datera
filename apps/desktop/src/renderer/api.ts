import type { DateraApi } from '../shared/contract.js';

/**
 * Turns the preload's envelope-returning bridge into the typed `DateraApi`.
 *
 * This runs in the **main world**, which is the whole point: an error constructed here
 * keeps its `code`, where one thrown across `contextBridge` would have it stripped.
 */
export class DateraClientError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'DateraError';
    this.code = code;
    this.details = details;
  }
}

interface Envelope {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; details: Record<string, unknown> };
}

type Bridge = Record<string, (...args: unknown[]) => Promise<Envelope>>;

const METHODS = [
  'engineInfo', 'listDatasets', 'listSources', 'addSource', 'removeSource',
  'getSchema', 'preview', 'query', 'pickFiles',
  'ask', 'listModels', 'setChatModel', 'setApiKey', 'hasApiKey', 'clearApiKey',
  'draftDictionary', 'getDictionary', 'confirmColumn', 'confirmEntity',
  'detectRelationships', 'confirmRelationship', 'listRelationships', 'createDataset',
  'explainTouched',
  'setEmbeddingModel', 'buildEmbeddings', 'semanticSearch', 'embeddingStatus',
  'listTools', 'callTool', 'connectConfig', 'queryTraceLog', 'getTraceRetention',
  'setTraceRetention', 'getTracePayloadCapture', 'setTracePayloadCapture', 'pruneTraceLog',
  'listEnvironments', 'environmentStatuses', 'addEnvironment', 'removeEnvironment',
  'pushDataset', 'remoteQuery',
  'getLifecycle', 'setLifecycle', 'resetLifecycle',
  'moveSource', 'renameDataset', 'deleteDataset', 'apiEndpoints',
] as const;

export function createApi(bridge: Bridge): DateraApi {
  const api: Record<string, unknown> = {};

  for (const method of METHODS) {
    api[method] = async (...args: unknown[]): Promise<unknown> => {
      const envelope = await bridge[method]?.(...args);
      if (envelope === undefined) {
        throw new DateraClientError('UNKNOWN', `The bridge has no "${method}" method.`, {});
      }
      if (envelope.ok) return envelope.value;
      throw new DateraClientError(
        envelope.error?.code ?? 'UNKNOWN',
        envelope.error?.message ?? 'Unknown error',
        envelope.error?.details ?? {},
      );
    };
  }

  return api as unknown as DateraApi;
}
