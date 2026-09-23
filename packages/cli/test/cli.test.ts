import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { connect } from 'node:net';
import { handleRpc, parseArgs, serveHttp, serveStdio, type RunningServer } from '@datera/cli';
import { fixturePaths, openTestWorkspace, testPorts, type FixturePaths, type TestWorkspace } from '@datera/testkit';

/**
 * §8 — the two transports.
 *
 * The CLI adds transports and nothing else. So these tests check that the protocol is
 * spoken correctly and that the core's guarantees survive the hop — not that the rules
 * themselves work, which is settled in the core's own suites.
 */
const INFO = { name: 'datera', version: '0.1.0' } as const;

describe('§8 MCP protocol', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('answers initialize with a protocol version and capabilities', async () => {
    const response = await handleRpc(ws.datera, { jsonrpc: '2.0', id: 1, method: 'initialize' }, INFO);
    const result = response?.result as { protocolVersion?: string; serverInfo?: { name: string } };

    expect(result.protocolVersion).toBeTruthy();
    expect(result.serverInfo?.name).toBe('datera');
  });

  it('returns no response for a notification', async () => {
    const response = await handleRpc(
      ws.datera, { jsonrpc: '2.0', method: 'notifications/initialized' }, INFO,
    );
    expect(response).toBeNull();
  });

  it('lists the auto-generated tools', async () => {
    const response = await handleRpc(ws.datera, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, INFO);
    const result = response?.result as { tools: { name: string }[] };

    expect(result.tools.map((t) => t.name)).toContain('query_ungrouped');
  });

  it('calls a tool and returns rows', async () => {
    const response = await handleRpc(
      ws.datera,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_ungrouped', arguments: { sql: 'SELECT count(*) AS n FROM orders' } } },
      INFO,
    );
    const result = response?.result as { isError: boolean; content: { text: string }[] };

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('6');
  });

  it('refuses a write over the wire (§12.9)', async () => {
    const response = await handleRpc(
      ws.datera,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'query_ungrouped', arguments: { sql: 'DELETE FROM orders' } } },
      INFO,
    );
    const result = response?.result as { isError: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/read-only/i);
  });

  it('reports an unknown method rather than ignoring it', async () => {
    const response = await handleRpc(ws.datera, { jsonrpc: '2.0', id: 5, method: 'evil/do' }, INFO);
    expect(response?.error?.code).toBe(-32601);
  });
});

describe('§8 stdio transport', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('speaks newline-delimited JSON-RPC', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on('data', (c: Buffer) => written.push(String(c)));

    const done = serveStdio({ datera: ws.datera, info: INFO, stdin, stdout, log: () => {} });

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
    await new Promise((r) => setTimeout(r, 120));
    stdin.end();
    await done;

    expect(written.join('')).toContain('protocolVersion');
  });

  it('handles a message split across chunks', async () => {
    // The failure that makes a stdio server flaky: a partial line parsed and discarded.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on('data', (c: Buffer) => written.push(String(c)));

    const done = serveStdio({ datera: ws.datera, info: INFO, stdin, stdout, log: () => {} });

    const message = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    stdin.write(message.slice(0, 12));
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(`${message.slice(12)}\n`);
    await new Promise((r) => setTimeout(r, 150));
    stdin.end();
    await done;

    expect(written.join('')).toContain('describe_schema');
  });

  it('reports a parse error rather than crashing', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on('data', (c: Buffer) => written.push(String(c)));

    const done = serveStdio({ datera: ws.datera, info: INFO, stdin, stdout, log: () => {} });
    stdin.write('this is not json\n');
    await new Promise((r) => setTimeout(r, 100));
    stdin.end();
    await done;

    expect(written.join('')).toContain('-32700');
  });
});

describe('§8 HTTP transport', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let server: RunningServer | null = null;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await ws.dispose();
  });

  it('serves MCP over HTTP on loopback', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain('query_ungrouped');
  });

  it('carries the client name from initialize into later calls, via a session', async () => {
    // Over stdio a client names itself once and the process remembers, because one
    // process serves one client. HTTP has no such thing, so every served request was
    // traced as an anonymous "Agent" no matter what the handshake said — the trace's
    // most useful field, blank, for the transport an agent is most likely to use.
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    const initialize = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Cursor' } },
      }),
    });

    const session = initialize.headers.get('mcp-session-id');
    expect(session).not.toBeNull();

    await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': session! },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'query_ungrouped', arguments: { sql: 'SELECT 1' } },
      }),
    });

    const [record] = await ws.datera.queryTraceLog({ limit: 1 });
    expect(record?.stages[0]?.label).toBe('Cursor');
    expect(record?.stages[1]?.label).toBe('HTTP');
  });

  it('still answers a client that never handshakes, without inventing a name', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'query_ungrouped', arguments: { sql: 'SELECT 1' } },
      }),
    });

    const [record] = await ws.datera.queryTraceLog({ limit: 1 });
    expect(record?.stages[0]?.label).toBe('Agent');
  });

  it('closes promptly even while an agent holds a keep-alive connection', async () => {
    // `server.close()` stops accepting and then waits for open connections to end, while
    // an HTTP client keeps its socket alive by default. Node has closed *idle* keep-alive
    // connections on close() since v19, so this holds today — it is pinned because the
    // desktop app waits on exactly this in `before-quit`, and anything long-lived added
    // to /mcp later (streaming, SSE) would turn quitting Datera into a hang.
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    await fetch(`${server.url}/healthz`);

    const closed = server.close();
    const raced = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);
    expect(raced).toBe('closed');
    server = null;
  });

  it('refuses an empty token rather than silently serving without one', async () => {
    // `--token ""` was accepted as a token: auth then returned true for everyone, while the
    // startup line printed "token required". An operator who believed the socket was
    // credentialed was wrong, and on loopback that is browser-reachable.
    await expect(
      serveHttp({ datera: ws.datera, info: INFO, port: 0, token: '', log: () => {} }),
    ).rejects.toThrow(/token/i);
  });

  it('rejects a cross-origin request, so a web page cannot drive it', async () => {
    // No Origin check meant any page the user visited could POST to the loopback server.
    // A simple request needs no preflight, so the response being unreadable does not help:
    // the state change has already happened.
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(403);
  });

  it('rejects a request whose Host is not loopback, so DNS rebinding fails', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    // Raw socket, not fetch: Host is a forbidden header name, so fetch silently drops an
    // override and the test would assert nothing at all.
    const status = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const socket = connect(server!.port, '127.0.0.1', () => {
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: attacker.example\r\n` +
            `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n\r\n${body}`,
        );
      });
      let text = '';
      socket.on('data', (d: Buffer) => { text += String(d); });
      socket.on('error', reject);
      socket.on('end', () => {
        const code = /^HTTP\/1\.1 (\d+)/.exec(text)?.[1];
        resolve(Number(code ?? 0));
      });
    });

    expect(status).toBe(403);
  });

  it('refuses a body large enough to exhaust memory', async () => {
    // Unbounded buffering on a socket the desktop app opens while holding the workspace.
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(40 * 1024 * 1024),
    }).catch(() => ({ status: 413 }) as Response);

    expect(response.status).toBe(413);
  });

  it('answers health checks without a credential', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, token: 'secret-token', log: () => {} });

    const response = await fetch(`${server.url}/healthz`);
    expect(response.status).toBe(200);
  });

  it('rejects a request with no token when one is required', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, token: 'secret-token', log: () => {} });

    const response = await fetch(`${server.url}/api/tools`);
    expect(response.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, token: 'secret-token', log: () => {} });

    const response = await fetch(`${server.url}/api/tools`, {
      headers: { authorization: 'Bearer wrong-token-x' },
    });
    expect(response.status).toBe(401);
  });

  it('accepts the right token', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, token: 'secret-token', log: () => {} });

    const response = await fetch(`${server.url}/api/tools`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(response.status).toBe(200);
  });

  it('refuses to bind beyond loopback without a token', async () => {
    // An unauthenticated data service on a LAN interface should be hard to start by
    // accident. Spec §10 gates writes hardest, but an open read is still an open door.
    await expect(
      serveHttp({ datera: ws.datera, info: INFO, port: 0, host: '0.0.0.0', log: () => {} }),
    ).rejects.toThrow(/token/i);
  });

  it('keeps read-only over HTTP', async () => {
    server = await serveHttp({ datera: ws.datera, info: INFO, port: 0, log: () => {} });

    const response = await fetch(`${server.url}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataset: 'ungrouped', sql: 'DROP TABLE orders' }),
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/read-only/i);
  });
});

describe('argument parsing', () => {
  it('parses the documented invocation from spec §8', () => {
    const options = parseArgs(['--mcp', '--workspace', '/tmp/ws']);
    expect(options.mcp).toBe(true);
    expect(options.workspace).toBe('/tmp/ws');
  });

  it('parses the HTTP form', () => {
    const options = parseArgs(['--http', '7391', '--host', '0.0.0.0', '--token', 'abc']);
    expect(options.httpPort).toBe(7391);
    expect(options.host).toBe('0.0.0.0');
    expect(options.token).toBe('abc');
  });
});
