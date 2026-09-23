#!/usr/bin/env node
/**
 * Drive Datera's MCP server the way an agent does.
 *
 * Datera serves agents, and until now the only way to exercise that was to wire up a real
 * one — so the served path was tested through its own API rather than over the wire it
 * actually runs on. This speaks the protocol: launches the server over stdio, completes
 * the initialize handshake with a client name, lists the tools and calls them.
 *
 * It is also how you see the agent and transport hops in a trace, because those exist
 * only for a request that genuinely arrived from outside.
 *
 * Usage:
 *   node scripts/mcp-client.mjs [--workspace <path>] [--client <name>] [--tool <name>] [--args <json>]
 *   node scripts/mcp-client.mjs --list
 *
 * The server opens the workspace read-write, so the desktop app must not be running
 * against the same one — DuckDB permits a single writer, and the second gets a lock
 * error rather than corrupting anything.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const workspace = resolve(
  flag('workspace', join(homedir(), 'Library/Application Support/Datera/workspaces/default')),
);
const clientName = flag('client', 'Claude Code');
const listOnly = process.argv.includes('--list');

const server = spawn(
  process.execPath,
  [join(root, 'packages/cli/dist/bin.js'), '--mcp', '--workspace', workspace],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);

// The server's own logging goes to stderr precisely so stdout stays a clean JSON-RPC
// channel; surfacing it here is what makes a failure to start legible.
server.stderr.on('data', (chunk) => process.stderr.write(`  [server] ${chunk}`));

const pending = new Map();
let nextId = 1;

createInterface({ input: server.stdout }).on('line', (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`  [unparseable] ${line}\n`);
    return;
  }
  const resolvePending = pending.get(message.id);
  if (resolvePending !== undefined) {
    pending.delete(message.id);
    resolvePending(message);
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolvePending, reject) => {
    pending.set(id, resolvePending);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 60_000).unref();
  });
}

function show(label, value) {
  console.log(`\n${label}`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

try {
  // The handshake is where a client says who it is — and the only place Datera can learn
  // the name it later shows on the agent hop of a trace.
  const initialized = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: clientName, version: '1.0.0' },
  });
  console.log(`Connected to ${initialized.result?.serverInfo?.name ?? 'datera'} as "${clientName}".`);

  const tools = (await call('tools/list', {})).result?.tools ?? [];
  console.log(`\n${tools.length} tool(s) offered:`);
  for (const tool of tools) {
    const args = Object.keys(tool.inputSchema?.properties ?? {}).join(', ');
    console.log(`  ${tool.name}(${args})`);
  }

  if (!listOnly) {
    const name = flag('tool', tools.find((t) => t.name.startsWith('query_'))?.name);
    if (name === undefined) {
      console.log('\nNo tool to call — pass --tool.');
    } else {
      const args = JSON.parse(
        flag('args', JSON.stringify({ sql: 'SELECT 1 AS it_works' })),
      );
      const result = await call('tools/call', { name, arguments: args });
      show(`Called ${name}:`, result.result?.content?.[0]?.text ?? result.error ?? result.result);
    }
  }
} finally {
  server.stdin.end();
  server.kill();
}
