import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type * as LlamaCppModule from 'node-llama-cpp';
import {
  ALL_BUNDLED_MODELS,
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
  /**
   * A read-only location checked before `directory`, for weights shipped inside the
   * installer.
   *
   * The default build fetches on demand, which is right: a 2.1 GB file cannot be a GitHub
   * release asset, and bundling would charge every user for a tier some never touch. But a
   * classroom with no per-student internet cannot download anything, so a second artifact
   * carries the weights — and an app bundle is not writable, so the seed is read in place
   * rather than copied. Copying would also double two gigabytes of disk for no gain.
   */
  readonly seedDirectory?: string | undefined;
}

type LlamaModule = typeof LlamaCppModule;

export class NodeLocalLlm implements LocalLlmPort {
  private llama: Awaited<ReturnType<LlamaModule['getLlama']>> | null = null;
  private loaded: { modelId: string; model: unknown; context: unknown } | null = null;
  private embedder: { modelId: string; model: unknown; context: unknown } | null = null;
  private module: LlamaModule | null = null;

  private readonly models: readonly BundledModelSpec[];

  constructor(private readonly options: NodeLocalLlmOptions) {
    this.models = options.models ?? ALL_BUNDLED_MODELS;
  }

  private spec(modelId: string): BundledModelSpec {
    const found = this.models.find((m) => m.id === modelId);
    if (found === undefined) throw new Error(`Unknown bundled model "${modelId}".`);
    return found;
  }

  async status(): Promise<readonly LocalModelStatus[]> {
    const total = totalmem();

    return Promise.all(
      this.models.map(async (spec) => {
        const resolved = await this.resolvePath(spec);
        const size = resolved === null
          ? (await stat(this.pathFor(spec.file)).catch(() => null))?.size ?? 0
          : spec.sizeBytes;

        // Judged against total memory, not free: free memory fluctuates with whatever the
        // user happens to have open, and telling someone their machine cannot run a model
        // because they had a browser open would be both wrong and unactionable.
        const fits = total >= spec.minFreeMemoryBytes * 1.5;

        return {
          modelId: spec.id,
          ready: resolved !== null,
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

    // Already here — downloaded, or shipped in the installer. Either way, nothing to do.
    if ((await this.resolvePath(spec)) !== null) return;

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

    // Counted *inside* the pipeline, as the bytes pass through to the file — not by a
    // 'data' listener beside it. A side listener puts the stream into flowing mode on its
    // own, so under some runtimes' timing a chunk can be counted and never written. The
    // length check then compared the counter, passed, and the hash failed with a message
    // saying the download was complete: it was not, and the check that existed to say so
    // was measuring the wrong thing.
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        // About every 8 MB: a progress event per chunk would spend more time crossing the
        // IPC boundary than downloading.
        if (received - lastReported >= 8_000_000 || received === total) {
          lastReported = received;
          onProgress?.({ modelId, receivedBytes: received, totalBytes: total });
        }
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(partial));

    // And the size is taken from the file itself. What matters is what is on disk.
    const written = (await stat(partial)).size;

    // Against the catalogue's size, not the server's Content-Length: the catalogue is what
    // was published and checksummed, and a header is only a claim about this response.
    if (written !== spec.sizeBytes) {
      await rm(partial, { force: true });
      throw new Error(
        `Downloading ${spec.label} ended early — ${gib(written)} GB of ${gib(spec.sizeBytes)} GB. ` +
          'That is usually a dropped connection rather than a problem with the file. Try again.',
      );
    }

    const digest = await sha256File(partial);
    if (digest !== spec.sha256) {
      await rm(partial, { force: true });
      throw new Error(
        `${spec.label} downloaded completely but does not match its published checksum ` +
          `(expected ${spec.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…). The file was ` +
          'discarded: a model is executable input, and one that is not what the publisher ' +
          'signed is not worth running. Trying again is reasonable — a corrupted transfer ' +
          'looks like this too.',
      );
    }

    await rename(partial, target);
  }

  async totalMemoryBytes(): Promise<number> {
    return totalmem();
  }

  /** Load ahead of the first question, so a cold model does not read as a slow one. */
  async warm(modelId: string): Promise<void> {
    try {
      await this.contextFor(modelId);
    } catch {
      // An optimisation. A machine that cannot warm the model will report that through
      // status(); failing here would turn a slow first answer into no answer at all.
    }
  }

  async remove(modelId: string): Promise<void> {
    const spec = this.spec(modelId);
    if (this.loaded?.modelId === modelId) await this.dispose();
    await rm(this.pathFor(spec.file), { force: true });
  }

  async generate(request: LocalGenerateRequest): Promise<LocalGenerateResult> {
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

  /**
   * Embed locally.
   *
   * An embedding context, not a chat one: the model has no chat template, and asking a
   * chat session for a vector would be a category error rather than a slow path. Held
   * separately from the chat model too — the two are different files and a workspace uses
   * both at once.
   */
  async embed(modelId: string, texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const spec = this.spec(modelId);
    const llama = await this.getLlama();

    if (this.embedder?.modelId !== modelId) {
      await this.disposeEmbedder();
      const modelPath = (await this.resolvePath(spec)) ?? this.pathFor(spec.file);
      const model = await llama.loadModel({ modelPath });
      const context = await model.createEmbeddingContext({ contextSize: spec.contextTokens });
      this.embedder = { modelId, model, context };
    }

    const context = this.embedder.context as {
      getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }>;
    };

    const vectors: (readonly number[])[] = [];
    for (const text of texts) {
      vectors.push((await context.getEmbeddingFor(text)).vector);
    }
    return vectors;
  }

  private async disposeEmbedder(): Promise<void> {
    const embedder = this.embedder;
    this.embedder = null;
    if (embedder === null) return;
    await (embedder.context as { dispose(): Promise<void> }).dispose().catch(() => undefined);
    await (embedder.model as { dispose(): Promise<void> }).dispose().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.disposeEmbedder();
    const loaded = this.loaded;
    this.loaded = null;
    if (loaded === null) return;
    await (loaded.context as { dispose(): Promise<void> }).dispose().catch(() => undefined);
    await (loaded.model as { dispose(): Promise<void> }).dispose().catch(() => undefined);
  }

  private pathFor(file: string): string {
    return join(this.options.directory, file);
  }

  /**
   * Where a model's weights actually are: the downloaded copy if there is one, otherwise
   * the seed.
   *
   * Downloaded wins, so that choosing a larger model later overrides whatever shipped in
   * the installer — the user's decision should beat the packager's.
   */
  private async resolvePath(spec: BundledModelSpec): Promise<string | null> {
    const downloaded = this.pathFor(spec.file);
    if (((await stat(downloaded).catch(() => null))?.size ?? 0) === spec.sizeBytes) return downloaded;

    const seedDirectory = this.options.seedDirectory;
    if (seedDirectory === undefined) return null;

    const seeded = join(seedDirectory, spec.file);
    return ((await stat(seeded).catch(() => null))?.size ?? 0) === spec.sizeBytes ? seeded : null;
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

    const modelPath = (await this.resolvePath(spec)) ?? this.pathFor(spec.file);
    const model = await llama.loadModel({ modelPath });
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
