#!/usr/bin/env node
/**
 * Register this workspace with a local agent, so "connect an agent" is a command rather
 * than a copied snippet.
 *
 * Settings → Serving generates the config, which is the right thing for Claude Desktop
 * and Cursor, where pasting into a file is the only option. Claude Code has a CLI, so
 * here it can simply be done.
 *
 * Usage:
 *   node scripts/connect-agent.mjs                 register (local scope)
 *   node scripts/connect-agent.mjs --print         show the config without registering
 *   node scripts/connect-agent.mjs --remove        unregister
 *   node scripts/connect-agent.mjs --scope user    register for every project
 *
 * Note the single-writer constraint: the server opens the workspace read-write, so the
 * desktop app must be closed while an agent is connected to the same one. Pass
 * --workspace to point an agent at a different workspace and run both at once.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
const scope = flag('scope', 'local');
const name = flag('name', 'datera');
const server = join(root, 'packages/cli/dist/bin.js');

if (!existsSync(server)) {
  console.error(`The CLI is not built: ${server}\nRun \`npx tsc -b\` first.`);
  process.exit(1);
}
if (!existsSync(workspace)) {
  console.error(`No workspace at ${workspace}\nOpen Datera once to create one, or pass --workspace.`);
  process.exit(1);
}

// Exactly what Settings → Serving generates, with the repo's built CLI standing in for the
// `datera` binary that an installed copy would put on PATH.
const config = {
  mcpServers: {
    [name]: { command: process.execPath, args: [server, '--mcp', '--workspace', workspace] },
  },
};

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

const remove = process.argv.includes('--remove');
const args = remove
  ? ['mcp', 'remove', name, '--scope', scope]
  : ['mcp', 'add', name, '--scope', scope, '--', process.execPath, server, '--mcp', '--workspace', workspace];

const result = spawnSync('claude', args, { stdio: 'inherit' });
if (result.error !== undefined) {
  console.error(
    `Could not run \`claude\`: ${result.error.message}\n` +
      'Add this to your MCP client configuration instead:\n' +
      JSON.stringify(config, null, 2),
  );
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

if (!remove) {
  console.log(
    `\nRegistered "${name}" (${scope} scope) against ${workspace}\n` +
      'Close the Datera app before an agent calls it — DuckDB allows one writer, and the\n' +
      'app holds the workspace while it is open.',
  );
}
