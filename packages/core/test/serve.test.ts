import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATASET_ID } from '@datera/core';
import {
  fixturePaths, openTestWorkspace, startStubModelServer, testPorts,
  type FixturePaths, type StubModelServer, type TestWorkspace,
} from '@datera/testkit';

/**
 * Phase 7 — serve (spec §8) and the persisted trace log (spec §8a).
 *
 * The core owns the tool *definitions* and the handlers; the transports are hosts. So
 * these tests drive the handler directly, which is also the layer `datera-server` will
 * call — meaning what is proven here holds for the server without re-proving it there.
 */
describe('§8 auto-generated tools', () => {
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

  it('generates a query and describe tool per dataset', async () => {
    const tools = await ws.datera.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('query_ungrouped');
    expect(names).toContain('describe_schema');
  });

  it('describes each tool well enough for an agent to use it', async () => {
    const tools = await ws.datera.listTools();
    const query = tools.find((t) => t.name === 'query_ungrouped');

    expect(query?.description).toMatch(/read-only/i);
    expect(query?.inputSchema.properties).toHaveProperty('sql');
    expect(query?.inputSchema.required).toContain('sql');
  });

  it('offers no search tool until something is embedded', async () => {
    // A tool that is advertised and then fails is worse than one that is absent.
    const tools = await ws.datera.listTools();
    expect(tools.map((t) => t.name)).not.toContain('search_ungrouped');
  });

  it('offers no mutation tool without a write grant (§6)', async () => {
    const tools = await ws.datera.listTools();
    expect(tools.map((t) => t.name)).not.toContain('propose_write_ungrouped');
  });

  it('offers a mutation tool once a grant exists, and it only proposes', async () => {
    const derived = await ws.datera.deriveDataset(DEFAULT_DATASET_ID, { name: 'Copy' });
    await ws.datera.grantWrite(derived.datasetId);

    const tools = await ws.datera.listTools();
    const mutate = tools.find((t) => t.name.startsWith('propose_write_'));

    expect(mutate).toBeDefined();
    // §6: agent-proposed mutations surface for human approval, never auto-execute. The
    // tool name and description both have to make that unmistakable to the agent.
    expect(mutate?.name).toContain('propose');
    expect(mutate?.description).toMatch(/does not execute|human|confirm/i);
  });
});

describe('§8 calling a tool', () => {
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

  it('runs a read query and returns rows', async () => {
    const result = await ws.datera.callTool('query_ungrouped', { sql: 'SELECT count(*) AS n FROM orders' });

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain('6');
  });

  it('refuses a write over the wire, grant or no grant (§12.9)', async () => {
    const result = await ws.datera.callTool('query_ungrouped', { sql: 'DELETE FROM orders' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/read-only/i);
  });

  it('refuses a cross-dataset reach over the wire', async () => {
    await ws.datera.createDataset({ id: 'other', name: 'Other' });
    const result = await ws.datera.callTool('query_ungrouped', { sql: 'SELECT * FROM ds_other.x' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/outside|dataset/i);
  });

  it('describes a schema without exposing another dataset', async () => {
    await ws.datera.createDataset({ id: 'other', name: 'Other' });
    const result = await ws.datera.callTool('describe_schema', { dataset: 'ungrouped' });

    const text = JSON.stringify(result.content);
    expect(text).toContain('orders');
    expect(text).not.toContain('ds_other');
  });

  it('reports an unknown tool rather than doing something surprising', async () => {
    const result = await ws.datera.callTool('drop_everything', {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/unknown tool/i);
  });

  it('emits a complete end-to-end trace for every served call (§12.9)', async () => {
    const result = await ws.datera.callTool('query_ungrouped', { sql: 'SELECT 1' });

    expect(result.trace).toBeDefined();
    const hops = result.trace!.stages.map((s) => s.kind);
    // Agent → transport → server → router → engine → response. The model hop is absent
    // for a direct SQL tool, and its absence is itself accurate.
    expect(hops).toContain('parse');
    expect(hops).toContain('guard');
    expect(hops).toContain('execute');
  });
});

describe('§8 connect configs', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('generates a stdio config for Claude Desktop', async () => {
    const config = await ws.datera.connectConfig('claude-desktop');
    const parsed = JSON.parse(config.content) as Record<string, unknown>;

    expect(config.transport).toBe('stdio');
    expect(JSON.stringify(parsed)).toContain('--mcp');
    expect(JSON.stringify(parsed)).toContain('--workspace');
  });

  it('generates an HTTP config carrying a bearer token', async () => {
    const config = await ws.datera.connectConfig('cursor', { url: 'http://localhost:7391', token: 'dtra_abc' });

    expect(config.transport).toBe('http');
    expect(config.content).toContain('Bearer dtra_abc');
    expect(config.content).toContain('/mcp');
  });

  it('does not invent a token when none was supplied', async () => {
    const config = await ws.datera.connectConfig('cursor', { url: 'http://localhost:7391' });
    expect(config.content).not.toMatch(/Bearer\s+\w/);
  });
});

describe('§8a the trace log', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;
  let server: StubModelServer;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    server = await startStubModelServer();
    ws = await openTestWorkspace({ ports: testPorts({ http: true }) });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
    await ws.datera.setChatModel({
      tier: 'detected', provider: 'ollama', id: 'llama3.1:8b', role: 'chat',
      locality: 'local', endpoint: server.url, label: 'llama3.1:8b',
    });
  });

  afterEach(async () => {
    await ws.dispose();
    await server.close();
  });

  it('persists a record per request', async () => {
    server.setReply('SELECT count(*) FROM orders');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'how many orders');

    const log = await ws.datera.queryTraceLog({});
    expect(log).toHaveLength(1);
    expect(log[0]?.datasetId).toBe(DEFAULT_DATASET_ID);
    expect(log[0]?.route).toBe('structured');
    expect(log[0]?.modelName).toContain('llama3.1:8b');
    expect(log[0]?.sql).toContain('SELECT');
  });

  it('stores shape and metadata but NOT payloads, by default', async () => {
    server.setReply('SELECT product FROM orders');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'products');

    const [record] = await ws.datera.queryTraceLog({});

    // Always stored: enough to search and to audit.
    expect(record?.totalMs).toBeGreaterThanOrEqual(0);
    expect(record?.inputTokens).toBeGreaterThan(0);
    expect(record?.rowsReturned).toBeGreaterThan(0);

    // Opt-in only: the log must not become a second copy of the data (§8a).
    expect(record?.payload).toBeNull();
    expect(JSON.stringify(record)).not.toContain('Trail Hoodie');
  });

  it('stores payloads once explicitly enabled', async () => {
    await ws.datera.setTracePayloadCapture(true);
    server.setReply('SELECT product FROM orders');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'products');

    const [record] = await ws.datera.queryTraceLog({});
    expect(record?.payload).not.toBeNull();
  });

  it('is searchable by SQL, like any other dataset (§8a)', async () => {
    server.setReply('SELECT count(*) FROM orders');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'how many orders');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'how many again');

    // The design rule: logs are a dataset queried by Datera's own engine. No second
    // search stack.
    const slow = await ws.datera.queryTraceLog({ minTotalMs: 0, limit: 10 });
    expect(slow.length).toBe(2);

    const filtered = await ws.datera.queryTraceLog({ route: 'structured' });
    expect(filtered.length).toBe(2);
  });

  it('prunes past the retention window', async () => {
    server.setReply('SELECT 1');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'one');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'two');
    expect(await ws.datera.queryTraceLog({})).toHaveLength(2);

    await ws.datera.setTraceRetention({ maxRecords: 1 });
    await ws.datera.pruneTraceLog();

    expect(await ws.datera.queryTraceLog({})).toHaveLength(1);
  });

  it('never becomes unbounded — retention has a default', async () => {
    const retention = await ws.datera.getTraceRetention();
    expect(retention.maxRecords).toBeGreaterThan(0);
    expect(retention.maxAgeDays).toBeGreaterThan(0);
  });

  it('records a served tool call too, not only Ask', async () => {
    await ws.datera.callTool('query_ungrouped', { sql: 'SELECT 1' });

    const log = await ws.datera.queryTraceLog({});
    expect(log.some((r) => r.origin === 'tool')).toBe(true);
  });

  it('never stores a credential', async () => {
    await ws.datera.setApiKey('openai', 'sk-trace-leak-test-123456');
    await ws.datera.setTracePayloadCapture(true);
    server.setReply('SELECT 1');
    await ws.datera.ask(DEFAULT_DATASET_ID, 'anything');

    const log = await ws.datera.queryTraceLog({});
    expect(JSON.stringify(log)).not.toContain('sk-trace-leak-test-123456');
  });
});

/**
 * Where a served request came from (§12.9).
 *
 * A trace used to begin inside Datera, which is accurate and incomplete: for an
 * agent-driven call the interesting question is often *what* asked and *how it got
 * here*, and that was exactly the part nobody could see. The two hops before Datera are
 * supplied by the host, because only the host knows whether it is being driven over
 * stdio, over HTTP, or from the app's own UI.
 */
describe('a served request records where it came from', () => {
  let ws: TestWorkspace;
  let fixtures: FixturePaths;

  beforeEach(async () => {
    fixtures = fixturePaths(process.env['DATERA_FIXTURES'] as string);
    ws = await openTestWorkspace({ ports: testPorts() });
    await ws.datera.addSource({ type: 'file', path: fixtures.ordersCsv, name: 'orders' });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('begins with the agent and the transport it arrived over', async () => {
    const result = await ws.datera.callTool(
      'query_ungrouped',
      { sql: 'SELECT count(*) FROM orders' },
      { transport: 'stdio', client: 'Claude Code' },
    );

    const kinds = result.trace!.stages.map((s) => s.kind);
    expect(kinds[0]).toBe('agent');
    expect(kinds[1]).toBe('transport');

    expect(result.trace!.stages[0]?.label).toBe('Claude Code');
    expect(result.trace!.stages[1]?.label).toBe('stdio');
    // stdio's actual security property, said where someone is looking at the hop.
    expect(result.trace!.stages[1]?.detail).toMatch(/no port, no token/i);
  });

  it('names HTTP differently, because it is a different claim', async () => {
    const result = await ws.datera.callTool(
      'query_ungrouped',
      { sql: 'SELECT count(*) FROM orders' },
      { transport: 'http' },
    );

    expect(result.trace!.stages[1]?.label).toBe('HTTP');
    expect(result.trace!.stages[1]?.detail).toMatch(/token/i);
    // No client named itself, so it is not invented.
    expect(result.trace!.stages[0]?.label).toBe('Agent');
  });

  it('starts at Datera for a local call, rather than inventing a caller', async () => {
    const result = await ws.datera.callTool('query_ungrouped', {
      sql: 'SELECT count(*) FROM orders',
    });

    const kinds = result.trace!.stages.map((s) => s.kind);
    expect(kinds).not.toContain('agent');
    expect(kinds).not.toContain('transport');
  });

  it('keeps those hops in the persisted log, not just the live result', async () => {
    await ws.datera.callTool(
      'query_ungrouped',
      { sql: 'SELECT count(*) FROM orders' },
      { transport: 'stdio', client: 'Cursor' },
    );

    const [record] = await ws.datera.queryTraceLog({ limit: 1 });
    expect(record?.stages[0]?.label).toBe('Cursor');
  });
});
