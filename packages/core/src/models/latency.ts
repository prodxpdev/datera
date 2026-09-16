import type { ChatRequest, ModelDescriptor } from './types.js';

/**
 * How long to wait, and what to send first (#33).
 *
 * The original report: a 14b model on a MacBook Air took 45 seconds with no feedback and
 * could exceed the flat 120-second timeout. Two policies come out of that, and both live
 * here rather than in the three provider clients that would otherwise each get them
 * slightly wrong.
 */

/** A remote provider that has not answered in a minute is broken, not slow. */
const REMOTE_TIMEOUT_MS = 60_000;

/**
 * Local models get five minutes.
 *
 * Measured on this project: 35 seconds for a first generation straight after a download,
 * nearly all of it reading weights off disk, and that was a 3B on a fast machine. A 7B on
 * a laptop with a busy disk is a multiple of that. The old 120-second ceiling turned a
 * slow load into a failure, which then read as "local models do not work".
 */
const LOCAL_TIMEOUT_MS = 300_000;

export function timeoutForModel(model: ModelDescriptor): number {
  return model.locality === 'local' ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS;
}

/**
 * A request whose only purpose is to make the runtime load the model.
 *
 * Ollama and LM Studio load weights on first use, so the first real question pays for it.
 * Sending a one-token request when the model is *chosen* moves that cost to a moment the
 * user is not waiting on an answer.
 *
 * Null for remote models: there is nothing to warm, and a call to a metered API that
 * exists only to speed up the next one is someone's money spent on nothing.
 */
export function warmupRequestFor(model: ModelDescriptor): ChatRequest | null {
  if (model.locality !== 'local') return null;

  return {
    messages: [{ role: 'user', content: 'ok' }],
    maxTokens: 1,
    temperature: 0,
    timeoutMs: timeoutForModel(model),
  };
}
