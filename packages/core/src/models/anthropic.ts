import { DateraError } from '../errors.js';
import type { HttpPort } from '../ports/http.js';
import { trimSlash } from './openai-compatible.js';
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

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 2_048;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AnthropicOptions {
  readonly http: HttpPort;
  readonly apiKey: string;
  readonly modelId: string;
  readonly baseUrl?: string | undefined;
}

/**
 * Anthropic's Messages API.
 *
 * Separate from the OpenAI-compatible client for two real differences, not for taste: the
 * system prompt is a **top-level field** rather than a message in the array, and
 * `max_tokens` is **required**. Trying to serve both shapes through one client would mean
 * a conditional in every method, which is how one of the two quietly stops being tested.
 */
export class AnthropicChatModel implements ChatModel {
  readonly descriptor: ModelDescriptor;

  constructor(private readonly options: AnthropicOptions) {
    this.descriptor = {
      tier: 'remote',
      provider: 'anthropic',
      id: options.modelId,
      role: 'chat',
      locality: 'remote',
      label: options.modelId,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const base = trimSlash(this.options.baseUrl ?? 'https://api.anthropic.com');
    const url = `${base}/v1/messages`;
    const started = Date.now();

    // System goes to its own field; everything else stays in order.
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const payload = {
      model: this.options.modelId,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: request.temperature ?? 0,
      ...(system.length > 0 ? { system } : {}),
      messages,
    };

    let response;
    try {
      response = await this.options.http.send({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (e) {
      throw this.failure(e instanceof Error ? e.message : String(e));
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.failure(`HTTP ${response.status}: ${response.body.slice(0, 400)}`);
    }

    let parsed: AnthropicMessage;
    try {
      parsed = JSON.parse(response.body) as AnthropicMessage;
    } catch {
      throw this.failure(`The response was not JSON: ${response.body.slice(0, 200)}`);
    }

    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    if (text.length === 0) {
      throw this.failure('The response contained no text content.');
    }

    const inputTokens =
      typeof parsed.usage?.input_tokens === 'number'
        ? parsed.usage.input_tokens
        : request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const outputTokens =
      typeof parsed.usage?.output_tokens === 'number' ? parsed.usage.output_tokens : estimateTokens(text);

    const pricing = pricingFor('anthropic', this.options.modelId, 'remote');

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

  private failure(detail: string): DateraError {
    return new DateraError(
      'MODEL_CALL_FAILED',
      `Anthropic call failed — ${redactSecrets(detail, this.options.apiKey)}`,
      { provider: 'anthropic', model: this.options.modelId },
    );
  }
}

interface AnthropicMessage {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown };
}
