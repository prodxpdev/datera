import { DateraError } from '../errors.js';
import type { HttpPort } from '../ports/http.js';
import { pricingFor } from './pricing.js';
import { redactSecrets } from './redact.js';
import {
  computeCost,
  estimateTokens,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  type ModelDescriptor,
} from './types.js';

export interface OpenAICompatibleOptions {
  readonly http: HttpPort;
  /** Base URL with no trailing path — `http://localhost:11434`, `https://api.openai.com`. */
  readonly baseUrl: string;
  readonly modelId: string;
  readonly descriptor: ModelDescriptor;
  /** Absent for a local runtime that wants no auth. Never stored on the descriptor. */
  readonly apiKey?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * One provider implementation for four of the five things Datera talks to.
 *
 * Ollama, LM Studio, a user's own OpenAI-compatible endpoint, and OpenAI itself all speak
 * `/v1/chat/completions` with the same request and response shape. Writing this once is
 * the reason spec §9's tier 2 is "any OpenAI-compatible endpoint" rather than a list of
 * integrations that has to grow every time a new local runtime appears.
 */
export class OpenAICompatibleChatModel implements ChatModel {
  readonly descriptor: ModelDescriptor;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.descriptor = options.descriptor;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${trimSlash(this.options.baseUrl)}/v1/chat/completions`;
    const started = Date.now();

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${this.options.apiKey}`;
    }

    const payload = {
      model: this.options.modelId,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      // Zero by default: generating SQL is not a place for sampling variety, and a
      // deterministic default is what makes a trace reproducible.
      temperature: request.temperature ?? 0,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      stream: false,
    };

    let response;
    try {
      response = await this.options.http.send({
        method: 'POST',
        url,
        headers,
        body: JSON.stringify(payload),
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (e) {
      throw this.failure(e instanceof Error ? e.message : String(e), url);
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.failure(`HTTP ${response.status}: ${response.body.slice(0, 400)}`, url);
    }

    let parsed: OpenAIChatCompletion;
    try {
      parsed = JSON.parse(response.body) as OpenAIChatCompletion;
    } catch {
      throw this.failure(`The response was not JSON: ${response.body.slice(0, 200)}`, url);
    }

    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw this.failure('The response contained no assistant message.', url);
    }

    // Prefer the provider's own counts. Estimation is a fallback, and one that is marked
    // as such wherever it surfaces — a guessed number presented as a measured one is the
    // small lie that makes the rest untrustworthy.
    const promptTokens = parsed.usage?.prompt_tokens;
    const completionTokens = parsed.usage?.completion_tokens;
    const inputTokens =
      typeof promptTokens === 'number'
        ? promptTokens
        : request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const outputTokens = typeof completionTokens === 'number' ? completionTokens : estimateTokens(text);

    const pricing = pricingFor(this.descriptor.provider, this.options.modelId, this.descriptor.locality);

    return {
      text,
      model: this.descriptor,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: pricing === null ? 0 : computeCost({ inputTokens, outputTokens }, pricing),
      },
      durationMs: Date.now() - started,
    };
  }

  private failure(detail: string, url: string): DateraError {
    const safe = redactSecrets(detail, this.options.apiKey);
    return new DateraError('MODEL_CALL_FAILED', `${this.descriptor.provider} call failed — ${safe}`, {
      provider: this.descriptor.provider,
      model: this.options.modelId,
      url: redactSecrets(url, this.options.apiKey),
    });
  }
}

interface OpenAIChatCompletion {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
