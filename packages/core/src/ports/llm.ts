/**
 * A local model runtime the host provides (spec §9 tier 1, §12.8).
 *
 * The bundled tier needs native code — llama.cpp bindings, GPU backends, a weights file
 * on disk — and the core has no host dependencies by construction (§1.7). So the core
 * owns the *catalogue* (which models, what they cost in RAM, what their checksums are)
 * and the *prompting*, and a host supplies the thing that actually runs them.
 *
 * That split is also what keeps the iPad path open: a webview host can implement this
 * against whatever it has, or omit it, and everything above the port is unchanged.
 */

export interface DownloadProgress {
  readonly modelId: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

export interface LocalModelStatus {
  readonly modelId: string;
  /** Weights are present, verified, and the runtime can load them. */
  readonly ready: boolean;
  /** Bytes on disk, when present. */
  readonly bytesOnDisk: number;
  /** Why it cannot run here, if it cannot — not enough memory, no runtime, and so on. */
  readonly unavailableReason: string | null;
}

export interface LocalGenerateRequest {
  readonly modelId: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
  /**
   * A GBNF grammar constraining the output.
   *
   * Not an optimisation. A 3B model asked politely for SQL returns prose about a third of
   * the time; constrained, it cannot. This is the difference between the bundled tier
   * being usable and being a demo.
   */
  readonly grammar?: string | undefined;
}

export interface LocalGenerateResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LocalLlmPort {
  /** What this machine can actually run, and what is already downloaded. */
  status(): Promise<readonly LocalModelStatus[]>;

  /**
   * Total physical memory, so the core can recommend a size.
   *
   * Reported by the host rather than measured in the core, which has no business knowing
   * what a machine is. The recommendation *policy* stays in the core, where it is pure
   * and testable.
   */
  totalMemoryBytes(): Promise<number>;

  /**
   * Load a model into memory ahead of being asked anything.
   *
   * Measured on this project: about two and a half seconds from a warm page cache, and
   * appreciably longer the first time after a download. Paying that on the first question
   * makes the model look slow when it is merely cold — so it is paid when the model is
   * chosen instead, while the user is still looking at the picker.
   *
   * Never throws: warming is an optimisation, and a failure here must not stop someone
   * asking a question.
   */
  warm(modelId: string): Promise<void>;

  /**
   * Fetch and verify the weights for a model.
   *
   * The one place the bundled tier touches the network, and it is an explicit act by the
   * user — never a side effect of asking a question. Verification is not optional: a
   * model file is executable input, and "it downloaded" is not the same as "it is what we
   * expected".
   */
  ensure(modelId: string, onProgress?: (progress: DownloadProgress) => void): Promise<void>;

  /** Remove the weights. Disk is the reason people uninstall things. */
  remove(modelId: string): Promise<void>;

  generate(request: LocalGenerateRequest): Promise<LocalGenerateResult>;

  /** Release any loaded model. Called when the workspace closes. */
  dispose(): Promise<void>;
}
