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
 *   node scripts/connect-agent.mjs                       register over stdio
 *   node scripts/connect-agent.mjs --url <url> --token <t>  register against a serving app
 *   node scripts/connect-agent.mjs --print               show the config, register nothing
 *   node scripts/connect-agent.mjs --remove              unregister
 *   node scripts/connect-agent.mjs --scope user          register for every project
 *
 * Which one you want depends on whether Datera is open.
 *
 * stdio launches the server itself, which opens the workspace read-write — and DuckDB
 * allows one writer, so this only works with the desktop app closed. With the app open,
 * turn on Settings → Serving and pass its --url and --token: the agent then reaches the
 * workspace the app is holding, and its requests appear in the app's own Activity view.
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
if (!existsSync(workspace) && !process.argv.includes('--url')) {
  console.error(`No workspace at ${workspace}\nOpen Datera once to create one, or pass --workspace.`);
  process.exit(1);
}

// Exactly what Settings → Serving generates, with the repo's built CLI standing in for the
// `datera` binary that an installed copy would put on PATH.
const url = flag('url', null);
const token = flag('token', process.env['DATERA_TOKEN'] ?? null);

const config = {
  mcpServers: {
    [name]:
      url === null
        ? { command: process.execPath, args: [server, '--mcp', '--workspace', workspace] }
        : {
            url: `${url.replace(/\/+$/, '')}/mcp`,
            ...(token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }),
          },
  },
};

if (process.argv.includes('--print')) {
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

const remove = process.argv.includes('--remove');

function addArgs() {
  if (url === null) {
    return ['mcp', 'add', name, '--scope', scope, '--', process.execPath, server, '--mcp', '--workspace', workspace];
  }
  const base = ['mcp', 'add', name, '--scope', scope, '--transport', 'http', `${url.replace(/\/+$/, '')}/mcp`];
  // Passed as a header rather than in the URL: a token in a URL ends up in logs and
  // shell history, which is most of the way to not having one.
  return token === null ? base : [...base, '--header', `Authorization: Bearer ${token}`];
}

const args = remove ? ['mcp', 'remove', name, '--scope', scope] : addArgs();

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
    url === null
      ? `\nRegistered "${name}" (${scope} scope) against ${workspace}\n` +
          'This launches its own server, so close the Datera app before an agent calls it —\n' +
          'DuckDB allows one writer, and the app holds the workspace while it is open.\n' +
          'To use both at once: Settings → Serving → Start serving, then re-run this with\n' +
          '--url and --token.'
      : `\nRegistered "${name}" (${scope} scope) against ${url}\n` +
          'Datera must be open and serving for this to answer. Its requests appear in the\n' +
          "app's Activity view, with the hop that shows they came from an agent.",
  );
}
