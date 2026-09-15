import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Ollama, LM Studio, OpenAI and Anthropic.
 *
 * Real servers are not available in CI, and a provider test that only runs when someone
 * happens to have Ollama running is a test that does not run. More importantly, this
 * records **exactly what Datera sent** — which is what acceptance §12.2 actually needs
 * asserted: that the model payload contains schema and dictionary and *no data rows*.
 * You cannot assert the absence of something in a request you never captured.
 */

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Parsed when the body was JSON; null otherwise. */
  readonly json: unknown;
}

export interface StubModelServer {
  readonly url: string;
  readonly port: number;
  readonly requests: readonly CapturedRequest[];
  /** What the next chat completion should answer with. */
  setReply(text: string): void;
  /**
   * Make every subsequent call fail with this status until `clearFailure`.
   *
   * Sticky rather than one-shot on purpose: "this runtime is broken" is the situation
   * worth modelling, and a one-shot failure let a prober fall through to a second
   * endpoint and get a healthy answer — which made a test pass for the wrong reason.
   */
  setFailure(status: number, body?: string): void;
  clearFailure(): void;
  /** Models reported by Ollama's /api/tags and OpenAI's /v1/models. */
  setModels(ids: readonly string[]): void;
  /** Delay every response, to exercise timeouts. */
  setLatency(ms: number): void;
  close(): Promise<void>;
}

/**
 * One server speaks every dialect at once — Ollama's `/api/tags`, the OpenAI-compatible
 * `/v1/chat/completions`, and Anthropic's `/v1/messages`. Routing by path rather than by
 * a configured flavour keeps the tests honest: a provider that called the wrong endpoint
 * would 404 here instead of being quietly answered.
 */
function parseJson(body: string): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export async function startStubModelServer(): Promise<StubModelServer> {
  const requests: CapturedRequest[] = [];

  let reply = 'SELECT 1';
  let models: readonly string[] = ['llama3.1:8b', 'nomic-embed-text'];
  let failure: { status: number; body: string } | null = null;
  let latency = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });

    req.on('end', () => {
      const json = parseJson(body);

      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]),
        ),
        body,
        json,
      });

      const respond = (status: number, payload: unknown): void => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };

      const handle = (): void => {
        if (failure !== null) {
          respond(failure.status, failure.body);
          return;
        }

        const path = req.url ?? '/';

        // Ollama's native model list.
        if (path.startsWith('/api/tags')) {
          respond(200, { models: models.map((name) => ({ name, model: name })) });
          return;
        }

        // OpenAI-compatible model list (Ollama, LM Studio and OpenAI all expose it).
        if (path.startsWith('/v1/models')) {
          respond(200, { data: models.map((id) => ({ id, object: 'model' })) });
          return;
        }

        if (path.startsWith('/v1/chat/completions')) {
          respond(200, {
            id: 'chatcmpl-stub',
            object: 'chat.completion',
            model: models[0] ?? 'stub',
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
          });
          return;
        }

        if (path.startsWith('/v1/messages')) {
          respond(200, {
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'claude-stub',
            content: [{ type: 'text', text: reply }],
            usage: { input_tokens: 123, output_tokens: 45 },
          });
          return;
        }

        respond(404, { error: 'not found' });
      };

      if (latency > 0) setTimeout(handle, latency);
      else handle();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setReply(text) {
      reply = text;
    },
    setFailure(status, responseBody = '{"error":"stub failure"}') {
      failure = { status, body: responseBody };
    },
    clearFailure() {
      failure = null;
    },
    setModels(ids) {
      models = ids;
    },
    setLatency(ms) {
      latency = ms;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
