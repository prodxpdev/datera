import type { HttpPort } from '../ports/http.js';
import { trimSlash } from './openai-compatible.js';
import type { ModelDescriptor } from './types.js';

/**
 * Spec §9 tier 2 — discover model runtimes the user already has running.
 *
 * Three rules from the spec govern everything here, and each one is a decision rather
 * than an implementation detail:
 *
 *  - **Best-effort.** A runtime that is absent is the normal case, not an error.
 *  - **Non-blocking.** Probes run concurrently under a short timeout, so three dead
 *    ports cost one timeout rather than three, and the UI never waits on a port scan.
 *  - **Never list a runtime that is not running.** Showing `llama3.1:8b` in a picker
 *    because Ollama was open yesterday produces a failure at the worst moment — after
 *    the user has chosen it and asked a question.
 */

export interface RuntimeCandidate {
  readonly provider: string;
  readonly baseUrl: string;
}

export interface DetectedRuntime {
  readonly provider: string;
  readonly baseUrl: string;
  readonly models: readonly ModelDescriptor[];
}

export interface DetectOptions {
  readonly http: HttpPort;
  readonly candidates?: readonly RuntimeCandidate[] | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The runtimes spec §9 names, on their default ports. */
export const DEFAULT_CANDIDATES: readonly RuntimeCandidate[] = [
  { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
  { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' },
];

/** Short on purpose: this runs while someone is looking at a settings pane. */
const DEFAULT_PROBE_TIMEOUT_MS = 700;

export async function detectLocalRuntimes(options: DetectOptions): Promise<readonly DetectedRuntime[]> {
  const candidates = options.candidates ?? DEFAULT_CANDIDATES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // Concurrent, and every probe resolves rather than rejects, so one unreachable port
  // cannot take the whole detection down with it.
  const results = await Promise.all(
    candidates.map(async (candidate) => probe(options.http, candidate, timeoutMs)),
  );

  return results.filter((r): r is DetectedRuntime => r !== null);
}

async function probe(
  http: HttpPort,
  candidate: RuntimeCandidate,
  timeoutMs: number,
): Promise<DetectedRuntime | null> {
  const base = trimSlash(candidate.baseUrl);

  // Ollama's native endpoint first, then the OpenAI-compatible one that LM Studio and
  // everything else expose. Ollama answers both; the order just avoids a wasted call.
  const endpoints =
    candidate.provider === 'ollama' ? [`${base}/api/tags`, `${base}/v1/models`] : [`${base}/v1/models`];

  for (const url of endpoints) {
    const ids = await tryList(http, url, timeoutMs);
    if (ids === null || ids.length === 0) continue;

    return {
      provider: candidate.provider,
      baseUrl: base,
      models: ids.map((id) => ({
        tier: 'detected' as const,
        provider: candidate.provider,
        id,
        role: 'chat' as const,
        locality: 'local' as const,
        endpoint: base,
        label: id,
      })),
    };
  }

  return null;
}

async function tryList(http: HttpPort, url: string, timeoutMs: number): Promise<readonly string[] | null> {
  try {
    const response = await http.send({ method: 'GET', url, timeoutMs });
    if (response.status < 200 || response.status >= 300) return null;

    const parsed: unknown = JSON.parse(response.body);
    return extractModelIds(parsed);
  } catch {
    // Every failure is the same answer: this runtime is not available right now. There is
    // nothing to report and nothing to raise — absence is the expected case.
    return null;
  }
}

/** Handles both `{models:[{name}]}` (Ollama) and `{data:[{id}]}` (OpenAI-compatible). */
function extractModelIds(parsed: unknown): readonly string[] | null {
  if (typeof parsed !== 'object' || parsed === null) return null;

  const ollama = (parsed as { models?: unknown }).models;
  if (Array.isArray(ollama)) {
    return ollama
      .map((m) => (typeof m === 'object' && m !== null ? (m as { name?: unknown }).name : undefined))
      .filter((n): n is string => typeof n === 'string');
  }

  const openai = (parsed as { data?: unknown }).data;
  if (Array.isArray(openai)) {
    return openai
      .map((m) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string');
  }

  return null;
}
