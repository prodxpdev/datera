/**
 * The model layer — spec §9's three provider tiers.
 *
 * Chat and embedding models are chosen **separately**, always, and embeddings default to
 * local even when chat is remote (invariant §1.6). That is why `ModelRole` exists rather
 * than one "the model" setting: a single selection is how a product ends up quietly
 * sending every text column to a remote embedder.
 */

export type ModelTier =
  /** Bundled local: no key, no account, runs on this machine. The default. */
  | 'bundled'
  /** A local runtime the user already installed — Ollama, LM Studio, any OpenAI-compatible endpoint. */
  | 'detected'
  /** Remote, with the user's own key. */
  | 'remote';

export type ModelRole = 'chat' | 'embedding';

export type Locality = 'local' | 'remote';

/**
 * Everything needed to name a model exactly, in a trace.
 *
 * Spec §9 requires the transparency stage and the serving trace to name the **exact**
 * model — tier, provider, id and locality — because "the local model" in an audit log
 * does not tell you which model wrote the SQL, and an audit log that cannot answer that
 * is not an audit log.
 */
export interface ModelDescriptor {
  readonly tier: ModelTier;
  /** e.g. 'ollama', 'lmstudio', 'openai-compatible', 'anthropic', 'openai', 'bundled'. */
  readonly provider: string;
  /** The provider's own identifier, verbatim: 'llama3.1:8b', 'claude-sonnet-4-5', … */
  readonly id: string;
  readonly role: ModelRole;
  readonly locality: Locality;
  /** Where it runs, when that is meaningful: 'localhost:11434'. Never includes a key. */
  readonly endpoint?: string | undefined;
  /** Human-facing one-liner for the picker. */
  readonly label: string;
}

/**
 * Render a descriptor the way a trace must show it.
 *
 * A single function so every surface spells it identically — `Ollama · llama3.1:8b
 * (local · :11434)`. Spec §9 makes this a requirement, and requirements that live in
 * three string templates drift.
 */
export function describeModel(model: ModelDescriptor): string {
  const where =
    model.endpoint === undefined
      ? model.locality
      : `${model.locality} · ${model.endpoint.replace(/^https?:\/\//, '')}`;
  return `${providerLabel(model.provider)} · ${model.id} (${where})`;
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case 'ollama':
      return 'Ollama';
    case 'lmstudio':
      return 'LM Studio';
    case 'openai-compatible':
      return 'OpenAI-compatible';
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'bundled':
      return 'Bundled';
    default:
      return provider;
  }
}

/** One message in a chat exchange. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number | undefined;
  /** Zero by default: SQL generation is not a place for creativity. */
  readonly temperature?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** USD. Zero for every local tier, and that zero is worth showing. */
  readonly costUsd: number;
}

export interface ChatResponse {
  readonly text: string;
  readonly model: ModelDescriptor;
  readonly usage: TokenUsage;
  readonly durationMs: number;
}

/**
 * A chat model Datera can call.
 *
 * Deliberately thin. Everything above this interface — prompt construction, SQL
 * extraction, the read-only guard, citations — is provider-independent, so switching
 * from a bundled model to Claude changes which SQL you get, never what Datera does
 * with it.
 */
export interface ChatModel {
  readonly descriptor: ModelDescriptor;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** What a provider costs, per million tokens. Local tiers are zero. */
export interface Pricing {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

export const FREE: Pricing = { inputPerMillionUsd: 0, outputPerMillionUsd: 0 };

export function computeCost(usage: { inputTokens: number; outputTokens: number }, pricing: Pricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillionUsd
  );
}

/**
 * A rough token estimate, used only when a provider does not report usage.
 *
 * Marked `estimated` wherever it surfaces. Reporting a guess as though it were measured
 * would be a small lie in exactly the place — the cost line — where the product's whole
 * claim is that you can trust what you are shown.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
