import { DateraError } from '../errors.js';
import type { LocalLlmPort } from '../ports/llm.js';
import type { ChatModel, ChatRequest, ChatResponse, ModelDescriptor } from './types.js';

/**
 * The bundled tier — spec §9 tier 1, acceptance §12.8.
 *
 * Answers with **no key configured and no network egress**. That is the whole reason this
 * tier exists: a local-first tool whose headline feature requires someone else's API is
 * not local-first, it is a client.
 *
 * ## Why these models
 *
 * Apache 2.0, decisively. Datera redistributes these weights, and the popular
 * alternatives at this size — Llama 3.2, Gemma 2 — carry redistribution conditions that
 * sit badly with a product whose §1.8 promise is that you are not locked in.
 *
 * Qwen2.5-Coder rather than a general chat model of the same size: the task is NL→SQL,
 * and a code-tuned 3B is markedly better at it than a general 3B. Q4_K_M rather than a
 * smaller quant because below 4-bit the SQL degrades faster than the memory saving is
 * worth.
 *
 * ## What it actually does, measured
 *
 * The 3B, against this project's own fixtures, with the grammar on:
 *
 *   - `total revenue in dollars by product` -> `SUM(revenue_cents) / 100` — sums first,
 *     then divides. Worth recording because the assumption going in was that it would
 *     get this wrong: a local 14B on this same project produced
 *     `SUM(revenue_cents / 100.0)`, which drifts. It did not.
 *   - A two-table join on a confirmed relationship: correct, with aliases.
 *   - An unanswerable question: declined, naming what was missing.
 *   - Roughly 0.7–2s per query once loaded; about 2.5s to load from a warm page cache,
 *     appreciably longer the first time after the download.
 *
 * ## The caveat that still holds
 *
 * A 3B is still weaker than a frontier model on long, multi-step or ambiguous questions,
 * and the UI keeps saying so (§9). But the honest framing is "smaller, and it shows on
 * hard questions", not "expect it to be wrong" — overstating the weakness would be as
 * much of a misrepresentation as hiding it, and the measurements above are why.
 */

export interface BundledModelSpec {
  readonly id: string;
  readonly label: string;
  /** File name on disk, and the name in the download URL. */
  readonly file: string;
  readonly url: string;
  /**
   * Lower-case hex SHA-256 of the file, taken from the publisher's own LFS metadata
   * rather than computed here — these are the values Hugging Face stores as the object
   * id, so verifying against them checks the file is the published one.
   */
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Free memory below which loading it is a bad idea rather than merely slow. */
  readonly minFreeMemoryBytes: number;
  readonly contextTokens: number;
  /** Said in the picker, verbatim. */
  readonly tradeoff: string;
}

const GIB = 1024 ** 3;

/**
 * Three sizes of one family, so the prompt and the parsing are a single code path.
 *
 * `default` is the 3B: it fits an 8 GB machine, loads in a couple of seconds via mmap,
 * and produces a short SQL statement in roughly the time a remote call would take once
 * latency is counted.
 */
export const BUNDLED_MODELS: readonly BundledModelSpec[] = [
  {
    id: 'qwen2.5-coder-1.5b-instruct-q4_k_m',
    label: 'Qwen2.5-Coder 1.5B',
    file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046',
    sizeBytes: 1_117_320_768,
    minFreeMemoryBytes: 2 * GIB,
    contextTokens: 4096,
    tradeoff: 'Smallest and fastest. Fine for single-table questions; weaker on joins.',
  },
  {
    id: 'qwen2.5-coder-3b-instruct-q4_k_m',
    label: 'Qwen2.5-Coder 3B',
    file: 'qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf',
    sha256: '724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7',
    sizeBytes: 2_104_932_800,
    minFreeMemoryBytes: 3 * GIB,
    contextTokens: 8192,
    tradeoff: 'The default. Fits an 8 GB machine; answers in about a second once loaded.',
  },
  {
    id: 'qwen2.5-coder-7b-instruct-q4_k_m',
    label: 'Qwen2.5-Coder 7B',
    file: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
    sizeBytes: 4_683_073_536,
    minFreeMemoryBytes: 6 * GIB,
    contextTokens: 8192,
    tradeoff: 'More headroom on complex queries. Needs 16 GB to be comfortable.',
  },
];

export const DEFAULT_BUNDLED_MODEL_ID = 'qwen2.5-coder-3b-instruct-q4_k_m';

export function bundledModel(modelId: string): BundledModelSpec {
  const spec = BUNDLED_MODELS.find((m) => m.id === modelId);
  if (spec === undefined) {
    throw new DateraError('INVALID_ARGUMENT', `Unknown bundled model "${modelId}".`, { modelId });
  }
  return spec;
}

export function bundledDescriptor(spec: BundledModelSpec): ModelDescriptor {
  return {
    tier: 'bundled',
    provider: 'bundled',
    id: spec.id,
    role: 'chat',
    locality: 'local',
    label: `${spec.label} — runs on this machine, no key, no network`,
  };
}

/**
 * A grammar that admits a single SQL statement and nothing else.
 *
 * The single biggest quality lever at this size. Unconstrained, a small model wraps its
 * answer in prose, a markdown fence, an apology, or all three, and the SQL extractor then
 * has to guess — which is exactly the kind of guessing this product refuses to do
 * elsewhere.
 *
 * Deliberately permissive about SQL *syntax*: it constrains the shape of the reply, not
 * the dialect. Validating DuckDB grammar here would duplicate the parser, and the
 * read-only guard already refuses anything that is not provably a read. The one escape
 * hatch is `CANNOT_ANSWER:` — declining must stay reachable, or a constrained model will
 * invent a query rather than admit it cannot answer (§1.5).
 */
export const SQL_GRAMMAR = String.raw`
root        ::= cannot | statement
cannot      ::= "CANNOT_ANSWER: " reason
reason      ::= [^\n]+
statement   ::= select ";"
select      ::= ("SELECT" | "WITH" | "EXPLAIN") body
body        ::= [^;]+
`.trim();

/**
 * Wraps the host's runtime as a ChatModel.
 *
 * Everything above `ChatModel` — prompt construction, SQL extraction, the read-only
 * guard, citations — is unchanged, which is the point of the interface being thin.
 */
export class BundledChatModel implements ChatModel {
  readonly descriptor: ModelDescriptor;

  constructor(
    private readonly llm: LocalLlmPort,
    private readonly spec: BundledModelSpec,
  ) {
    this.descriptor = bundledDescriptor(spec);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();

    // The runtime takes a system prompt and a single user turn, which is all Datera ever
    // sends: one question, one answer, no conversation to carry forward.
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const prompt = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n');

    const result = await this.llm.generate({
      modelId: this.spec.id,
      system,
      prompt,
      maxTokens: request.maxTokens ?? 512,
      grammar: SQL_GRAMMAR,
    });

    return {
      text: result.text,
      model: this.descriptor,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        // Zero, and that zero is worth showing: it is the argument for this tier.
        costUsd: 0,
      },
      durationMs: Date.now() - started,
    };
  }
}
