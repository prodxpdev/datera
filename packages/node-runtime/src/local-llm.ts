import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  BUNDLED_MODELS,
  type BundledModelSpec,
  type DownloadProgress,
  type LocalGenerateRequest,
  type LocalGenerateResult,
  type LocalLlmPort,
  type LocalModelStatus,
} from '@datera/core';

/**
 * The bundled tier's runtime — llama.cpp, on this machine (spec §9 tier 1, §12.8).
 *
 * Lives here rather than in the core because it is irreducibly host-specific: native
 * bindings, GPU backends, a multi-gigabyte file on disk. The core owns which models exist
 * and how they are prompted; this owns getting them and running them.
 *
 * `node-llama-cpp` is imported lazily. It pulls in a native addon and, on a machine that
 * never uses the bundled tier, loading it at startup would cost every user the price of a
 * feature only some of them want.
 */
export interface NodeLocalLlmOptions {
  /** Where weights live. Usually the app's data directory, not the workspace. */
  readonly directory: string;
  /** Overridable for tests. */
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * The catalogue to serve. Defaults to the core's.
   *
   * A seam, so the download-and-verify path can be tested end to end against a small file
   * with a known hash. Verifying two gigabytes in CI is not a test anyone runs, and a
   * success path nobody exercises is where the bug lives.
   */
  readonly models?: readonly BundledModelSpec[] | undefined;
}

type LlamaModule = typeof import('node-llama-cpp');

export class NodeLocalLlm implements LocalLlmPort {
  private llama: Awaited<ReturnType<LlamaModule['getLlama']>> | null = null;
  private loaded: { modelId: string; model: unknown; context: unknown } | null = null;
  private module: LlamaModule | null = null;

  private readonly models: readonly BundledModelSpec[];

  constructor(private readonly options: NodeLocalLlmOptions) {
    this.models = options.models ?? BUNDLED_MODELS;
  }

  private spec(modelId: string): BundledModelSpec {
    const found = this.models.find((m) => m.id === modelId);
    if (found === undefined) throw new Error(`Unknown bundled model "${modelId}".`);
    return found;
  }

  async status(): Promise<readonly LocalModelStatus[]> {
    const free = Math.max(freemem(), 0);
    const total = totalmem();

    return Promise.all(
      this.models.map(async (spec) => {
        const path = this.pathFor(spec.file);
        const size = (await stat(path).catch(() => null))?.size ?? 0;

        // Judged against total memory, not free: free memory fluctuates with whatever the
        // user happens to have open, and telling someone their machine cannot run a model
        // because they had a browser open would be both wrong and unactionable.
        const fits = total >= spec.minFreeMemoryBytes * 1.5;

        return {
          modelId: spec.id,
          ready: size === spec.sizeBytes,
          bytesOnDisk: size,
          unavailableReason: fits
            ? null
            : `Needs about ${gib(spec.minFreeMemoryBytes)} GB of memory to run comfortably; this machine has ${gib(total)} GB in total.`,
        } satisfies LocalModelStatus;
      }),
    );
  }

  /**
   * Download and verify.
   *
   * Two things this does not do, deliberately. It does not resume a partial file — a
   * half-written model that passes a length check and fails a hash check is a confusing
   * failure, and re-downloading two gigabytes is cheaper than debugging that. And it does
   * not write into place until the hash matches: the final rename is the only moment a
   * usable file appears, so an interrupted download leaves nothing behind that a later
   * run could mistake for a model.
   */
  async ensure(modelId: string, onProgress?: (progress: DownloadProgress) => void): Promise<void> {
    const spec = this.spec(modelId);
    const target = this.pathFor(spec.file);

    if (((await stat(target).catch(() => null))?.size ?? 0) === spec.sizeBytes) return;

    await mkdir(this.options.directory, { recursive: true });
    const partial = `${target}.partial`;
    await rm(partial, { force: true });

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(spec.url, { redirect: 'follow' });
    if (!response.ok || response.body === null) {
      throw new Error(`Downloading ${spec.label} failed: HTTP ${response.status}.`);
    }

    const total = Number(response.headers.get('content-length') ?? spec.sizeBytes);
    let received = 0;
    let lastReported = 0;

    const body = Readable.fromWeb(response.body as never);
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      // Reported about every 8 MB: a progress event per chunk would spend more time
      // crossing the IPC boundary than downloading.
      if (received - lastReported >= 8_000_000 || received === total) {
        lastReported = received;
        onProgress?.({ modelId, receivedBytes: received, totalBytes: total });
      }
    });

    await pipeline(body, createWriteStream(partial));

    const digest = await sha256File(partial);
    if (digest !== spec.sha256) {
      await rm(partial, { force: true });
      throw new Error(
        `${spec.label} failed verification. Expected ${spec.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…. ` +
          'The file was discarded — a model is executable input, and an unverified one is not worth running.',
      );
    }

    await rename(partial, target);
  }

  async remove(modelId: string): Promise<void> {
    const spec = this.spec(modelId);
    if (this.loaded?.modelId === modelId) await this.dispose();
    await rm(this.pathFor(spec.file), { force: true });
  }

  async generate(request: LocalGenerateRequest): Promise<LocalGenerateResult> {
    const spec = this.spec(request.modelId);
    const llama = await this.getLlama();
    const mod = this.module!;

    const context = await this.contextFor(request.modelId);

    // A context hands out a fixed number of sequences, and one is taken per generation.
    // Not returning it means the *second* question a user asks fails with "No sequences
    // left" — so this is released in a finally, not on the happy path.
    const sequence = (context as { getSequence(): { dispose(): void } }).getSequence();

    try {
      const session = new mod.LlamaChatSession({
        contextSequence: sequence as never,
        systemPrompt: request.system,
      });

      // The grammar is the single biggest quality lever at this size: unconstrained, a
      // small model wraps its answer in prose or a markdown fence often enough that the
      // extractor has to guess, and guessing is what this product refuses to do.
      const grammar =
        request.grammar === undefined
          ? undefined
          : await llama.createGrammar({ grammar: request.grammar });

      const text = await session.prompt(request.prompt, {
        maxTokens: request.maxTokens,
        // SQL generation is not a place for creativity.
        temperature: 0,
        ...(grammar === undefined ? {} : { grammar }),
      });

      const model = this.loaded!.model as { tokenize(t: string): unknown[] };
      return {
        text,
        inputTokens: model.tokenize(`${request.system}\n${request.prompt}`).length,
        outputTokens: model.tokenize(text).length,
      };
    } finally {
      sequence.dispose();
    }
  }

  async dispose(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    if (loaded === null) return;
    await (loaded.context as { dispose(): Promise<void> }).dispose().catch(() => undefined);
    await (loaded.model as { dispose(): Promise<void> }).dispose().catch(() => undefined);
  }

  private pathFor(file: string): string {
    return join(this.options.directory, file);
  }

  private async getLlama(): Promise<Awaited<ReturnType<LlamaModule['getLlama']>>> {
    if (this.llama !== null) return this.llama;
    // Lazy: the native addon costs startup time for everyone, and only some users ever
    // touch this tier.
    this.module = await import('node-llama-cpp');
    this.llama = await this.module.getLlama();
    return this.llama;
  }

  /** One model held at a time. Two 3B models resident is how an 8 GB machine starts swapping. */
  private async contextFor(modelId: string): Promise<unknown> {
    if (this.loaded?.modelId === modelId) return this.loaded.context;
    await this.dispose();

    const spec = this.spec(modelId);
    const llama = await this.getLlama();

    const model = await llama.loadModel({ modelPath: this.pathFor(spec.file) });
    const context = await model.createContext({ contextSize: spec.contextTokens });

    this.loaded = { modelId, model, context };
    return context;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
