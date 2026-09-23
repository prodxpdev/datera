import type { Datera } from '@datera/core';

/**
 * MCP over stdio (spec §8).
 *
 * The agent launches `datera --mcp --workspace …` and speaks JSON-RPC over the process's
 * stdin and stdout. No port, no token, no listening socket — for a single user on one
 * machine that is a meaningfully smaller attack surface than an HTTP server, which is why
 * §8 lists it first and why the generated Claude Desktop config uses it.
 *
 * The protocol is implemented directly rather than via an SDK: it is a handful of methods
 * over newline-delimited JSON-RPC, and a dependency here would be the only thing in the
 * CLI that could pull the core's guarantees out of alignment with what is served.
 */

const PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * Handle one JSON-RPC message.
 *
 * Exported separately from the transport so it can be tested without spawning a process,
 * and so the HTTP host can reuse it verbatim — one implementation of the protocol, two
 * ways of carrying it.
 */
/**
 * What called, and how it got here.
 *
 * Carried across a connection rather than per request, because the client only names
 * itself once, in the initialize handshake — which is the only place its name exists.
 */
export interface CallerContext {
  transport: 'stdio' | 'http';
  client?: string | undefined;
}

export async function handleRpc(
  datera: Datera,
  request: JsonRpcRequest,
  info: ServerInfo,
  caller: CallerContext = { transport: 'stdio' },
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  switch (request.method) {
    case 'initialize': {
      // The handshake is the one message that says who is calling. Kept, so every later
      // tool call can say so too instead of reporting an anonymous 'Agent'.
      const clientInfo = (request.params as { clientInfo?: { name?: unknown } } | undefined)?.clientInfo;
      if (typeof clientInfo?.name === 'string' && clientInfo.name.length > 0) {
        caller.client = clientInfo.name.slice(0, 64);
      }
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: info,
      });
    }

    // Notifications carry no id and expect no response.
    case 'notifications/initialized':
      return null;

    case 'ping':
      return ok({});

    case 'tools/list': {
      const tools = await datera.listTools();
      return ok({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    case 'tools/call': {
      const name = request.params?.['name'];
      if (typeof name !== 'string') return fail(-32602, 'A tool name is required.');
      const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;

      // Every guard lives in the core, so a request arriving over MCP is subject to
      // exactly the rules the UI is — read-only, the dataset boundary, and the write gate.
      const result = await datera.callTool(name, args, caller);
      return ok({ content: result.content, isError: result.isError });
    }

    default:
      return fail(-32601, `Unknown method "${request.method}".`);
  }
}

export interface StdioOptions {
  readonly datera: Datera;
  readonly info: ServerInfo;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  /** Diagnostics go here — never to stdout, which carries the protocol. */
  readonly log: (message: string) => void;
}

export function serveStdio(options: StdioOptions): Promise<void> {
  const { datera, info, stdin, stdout, log } = options;

  return new Promise((resolve) => {
    let buffer = '';

    stdin.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk);

      // Newline-delimited JSON. A partial line is kept for the next chunk rather than
      // parsed and discarded, which is the failure that makes a stdio server flaky under
      // any real message size.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        if (line.length === 0) continue;
        void dispatch(line);
      }
    });

    stdin.on('end', () => resolve());
    stdin.on('close', () => resolve());

    // One per process: a stdio server serves exactly one client, which is the whole
    // point of the transport.
    const caller: CallerContext = { transport: 'stdio' };

    async function dispatch(line: string): Promise<void> {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      try {
        const response = await handleRpc(datera, request, info, caller);
        if (response !== null) write(response);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`error handling ${request.method}: ${message}`);
        write({
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32603, message },
        });
      }
    }

    function write(response: JsonRpcResponse): void {
      stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
