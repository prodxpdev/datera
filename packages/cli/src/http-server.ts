import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Datera } from '@datera/core';
import { handleRpc, type JsonRpcRequest, type ServerInfo } from './mcp-stdio.js';

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

  if (!LOOPBACK.has(host) && (options.token === undefined || options.token.length === 0)) {
    throw new Error(
      `Refusing to listen on ${host} without a token. An unauthenticated data service ` +
        `reachable beyond this machine is not something Datera will start by accident. ` +
        `Set a token, or bind to 127.0.0.1.`,
    );
  }

  const server: Server = createServer((req, res) => {
    void route(req, res).catch((e: unknown) => {
      respond(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

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

      const response = await handleRpc(options.datera, request, options.info);
      respond(res, 200, response ?? {});
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
      const result = await options.datera.callTool(`query_${String(parsed.dataset ?? 'ungrouped')}`, {
        sql: parsed.sql ?? '',
      });
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
