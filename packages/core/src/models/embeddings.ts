import { DateraError } from '../errors.js';
import type { HttpPort } from '../ports/http.js';
import { trimSlash } from './openai-compatible.js';
import { redactSecrets } from './redact.js';
import type { ModelDescriptor } from './types.js';

/**
 * Embedding models (spec §9, invariant §1.6).
 *
 * A separate interface from `ChatModel`, and separately selected, because the two carry
 * very different privacy weight: the structured path sends a model your *schema*, while
 * the semantic path sends it your *text*. Embeddings therefore default to local even when
 * chat is remote, and a single "the model" setting would quietly undo that.
 */
export interface EmbeddingModel {
  readonly descriptor: ModelDescriptor;
  /** Returns one vector per input, in order. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface EmbeddingOptions {
  readonly http: HttpPort;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly descriptor: ModelDescriptor;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Batch size. Small enough that a local runtime is not asked for too much at once. */
export const EMBED_BATCH = 32;

/** `/v1/embeddings` — spoken by Ollama, LM Studio and OpenAI alike. */
export class OpenAICompatibleEmbeddingModel implements EmbeddingModel {
  readonly descriptor: ModelDescriptor;

  constructor(private readonly options: EmbeddingOptions) {
    this.descriptor = options.descriptor;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];

    const out: (readonly number[])[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      out.push(...(await this.embedBatch(texts.slice(i, i + EMBED_BATCH))));
    }
    return out;
  }

  private async embedBatch(batch: readonly string[]): Promise<readonly (readonly number[])[]> {
    const url = `${trimSlash(this.options.baseUrl)}/v1/embeddings`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${this.options.apiKey}`;
    }

    let response;
    try {
      response = await this.options.http.send({
        method: 'POST',
        url,
        headers,
        body: JSON.stringify({ model: this.options.modelId, input: [...batch] }),
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (e) {
      throw this.failure(e instanceof Error ? e.message : String(e));
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.failure(`HTTP ${response.status}: ${response.body.slice(0, 300)}`);
    }

    let parsed: { data?: readonly { embedding?: unknown }[] };
    try {
      parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
      throw this.failure('The embeddings response was not JSON.');
    }

    const vectors = (parsed.data ?? []).map((d) =>
      Array.isArray(d.embedding) ? (d.embedding as unknown[]).map(Number) : null,
    );

    if (vectors.length !== batch.length || vectors.some((v) => v === null)) {
      throw this.failure(
        `Expected ${batch.length} vectors, got ${vectors.filter((v) => v !== null).length}.`,
      );
    }

    return vectors as readonly (readonly number[])[];
  }

  private failure(detail: string): DateraError {
    return new DateraError(
      'MODEL_CALL_FAILED',
      `Embedding call failed — ${redactSecrets(detail, this.options.apiKey)}`,
      { provider: this.descriptor.provider, model: this.options.modelId },
    );
  }
}

/**
 * Whether a model id looks like an embedding model.
 *
 * Runtimes do not report a model's purpose, so the name is the only signal available. A
 * heuristic, and named as one — it decides what appears in a picker, not what happens to
 * anyone's data.
 */
export function looksLikeEmbeddingModel(id: string): boolean {
  return /embed|bge|gte-|e5-|minilm|nomic/i.test(id);
}
