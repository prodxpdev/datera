import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Datera } from '@datera/core';
import { handleRpc, type CallerContext, type JsonRpcRequest, type ServerInfo } from './mcp-stdio.js';

/**
 * MCP over HTTP, plus a small REST surface (spec §8).
 *
 * This lives in the CLI, not the core: the core must not depend on an HTTP server
 * (invariant §1.7), and `datera-server` will build its own host on the same handlers.
 *
 * Security posture, deliberately conservative for something that listens on a socket:
 *  - binds to loopback unless told otherwise, so "local API" means local by default;
 *  - a token, when set, is compared in constant time;
 *  - **without a token it refuses to bind to anything but loopback**, because an
 *    unauthenticated data service on a LAN interface is a mistake that should be hard to
 *    make by accident.
 */

export interface HttpServeOptions {
  readonly datera: Datera;
  readonly info: ServerInfo;
  readonly port: number;
  readonly host?: string;
  readonly token?: string | undefined;
  /**
   * Accept pushed datasets (spec §10).
   *
   * Off by default. Receiving a dataset means writing to the workspace, which is a
   * materially different grant from serving reads — so it is a separate, explicit opt-in
   * rather than something that comes along with starting a server.
   */
  readonly allowPush?: boolean | undefined;
  readonly log: (message: string) => void;
}

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export async function serveHttp(options: HttpServeOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';

  // An empty string was accepted as a token and then disabled authentication entirely,
  // while the startup line still announced "token required". Refused outright: an operator
  // who believes the socket is credentialed and is wrong is worse off than one with no
  // token at all, who at least knows.
  if (options.token !== undefined && options.token.length === 0) {
    throw new Error(
      'An empty token is not a token. Omit it to serve without authentication on loopback, ' +
        'or set a real one.',
    );
  }

  if (!LOOPBACK.has(host) && (options.token === undefined || options.token.length === 0)) {
    throw new Error(
      `Refusing to listen on ${host} without a token. An unauthenticated data service ` +
        `reachable beyond this machine is not something Datera will start by accident. ` +
        `Set a token, or bind to 127.0.0.1.`,
    );
  }

  /**
   * Named callers, by session.
   *
   * Bounded deliberately: this is a map an unauthenticated-ish caller could otherwise
   * grow without limit by handshaking in a loop. The oldest session is dropped, which
   * costs that client its name and nothing else.
   */
  const sessions = new Map<string, CallerContext>();
  const MAX_SESSIONS = 64;
  const remember = (id: string, caller: CallerContext): void => {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    sessions.set(id, caller);
  };

  const server: Server = createServer((req, res) => {
    void route(req, res).catch((e: unknown) => {
      const status = e instanceof BodyTooLarge ? 413 : 500;
      respond(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  /**
   * Refuse anything a browser sent on a page's behalf.
   *
   * Nothing checked Origin or Host, so a page the user happened to visit could POST to the
   * loopback server. A cross-origin *simple* request needs no preflight, so the response
   * being unreadable is no protection at all — /api/push and tools/call had already done
   * their work by then. The Host check is the other half: it stops a DNS rebind from
   * turning attacker.example into 127.0.0.1.
   */
  function fromABrowserElsewhere(req: IncomingMessage): boolean {
    const origin = req.headers['origin'];
    if (typeof origin === 'string' && origin.length > 0) return true;

    const hostHeader = req.headers['host'];
    if (typeof hostHeader === 'string') {
      const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!LOOPBACK.has(name)) return true;
    }
    return false;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    if (fromABrowserElsewhere(req)) {
      respond(res, 403, { error: 'This server answers local tools, not web pages.' });
      return;
    }

    // Liveness before auth: a health check that requires a credential is not a health
    // check, and §14.1 asks for /healthz and /readyz.
    if (url.startsWith('/healthz') || url.startsWith('/readyz')) {
      respond(res, 200, { ok: true });
      return;
    }

    if (!authorised(req, options.token)) {
      respond(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (url.startsWith('/mcp')) {
      const body = await readBody(req);
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      // A client names itself once, in the handshake, and over stdio the process simply
      // remembers because one process serves one client. HTTP has no such thing, so every
      // served request was traced as an anonymous "Agent" however the handshake
      // introduced itself — the trace's most useful field blank, on the transport an
      // agent is most likely to arrive over.
      //
      // `Mcp-Session-Id` is the protocol's own answer: the server issues one on
      // initialize and the client echoes it. A client that sends no session is still
      // served; it is simply not given a name it never provided.
      const existing = req.headers['mcp-session-id'];
      const caller: CallerContext =
        typeof existing === 'string' ? sessions.get(existing) ?? { transport: 'http' } : { transport: 'http' };

      const response = await handleRpc(options.datera, request, options.info, caller);

      const headers: Record<string, string> = {};
      if (request.method === 'initialize' && caller.client !== undefined) {
        const id = randomUUID();
        remember(id, caller);
        headers['mcp-session-id'] = id;
      }

      respond(res, 200, response ?? {}, headers);
      return;
    }

    if (url === '/api/operations' && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req)) as {
        dataset?: string; name?: string; arguments?: Record<string, unknown>;
      };
      if (typeof parsed.dataset !== 'string' || typeof parsed.name !== 'string') {
        respond(res, 400, { error: '"dataset" and "name" are required.' });
        return;
      }
      respond(
        res, 200,
        await options.datera.callOperation(parsed.dataset, parsed.name, parsed.arguments ?? {}),
      );
      return;
    }

    if (url.startsWith('/api/tools')) {
      respond(res, 200, { tools: await options.datera.listTools() });
      return;
    }

    if (url.startsWith('/api/datasets')) {
      respond(res, 200, { datasets: await options.datera.listDatasets() });
      return;
    }

    if (url.startsWith('/api/sources')) {
      respond(res, 200, { sources: await options.datera.listSources() });
      return;
    }

    if (url.startsWith('/api/push') && req.method === 'POST') {
      if (options.allowPush !== true) {
        respond(res, 403, {
          error:
            'This server does not accept pushed datasets. Start it with --allow-push to enable that.',
        });
        return;
      }

      const body = await readBody(req);
      const parsed = JSON.parse(body) as { manifest?: string; tables?: { name: string; csv: string }[] };
      if (parsed.manifest === undefined) {
        respond(res, 400, { error: 'A manifest is required.' });
        return;
      }

      const result = await options.datera.receivePush(parsed.manifest, parsed.tables ?? []);
      respond(res, 200, { ok: true, datasetId: result.datasetId, tables: result.tables });
      return;
    }

    if (url.startsWith('/api/query') && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as { dataset?: string; sql?: string };
      const result = await options.datera.callTool(
        `query_${String(parsed.dataset ?? 'ungrouped')}`,
        { sql: parsed.sql ?? '' },
        { transport: 'http' },
      );
      respond(res, result.isError ? 400 : 200, result);
      return;
    }

    respond(res, 404, { error: 'Not found' });
  }

  await new Promise<void>((resolve) => server.listen(options.port, host, resolve));
  const actual = (server.address() as { port: number }).port;

  options.log(
    `Datera serving MCP on http://${host}:${actual}/mcp ` +
      `(${options.token === undefined ? 'no token — loopback only' : 'token required'})`,
  );

  return {
    port: actual,
    url: `http://${host}:${actual}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function authorised(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined || token.length === 0) return true;

  const header = req.headers['authorization'];
  const provided = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';

  // Constant time, and length-checked first because timingSafeEqual throws on a mismatch.
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The largest request this will buffer.
 *
 * Generous enough for a pushed dataset, bounded because the alternative is that one request
 * can exhaust the memory of a process that — on the desktop host — is holding the user's
 * workspace open.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new BodyTooLarge(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respond(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}
