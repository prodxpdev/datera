import { Datera } from '@datera/core';
import {
  ConsoleLogger, NodeFileSystem, NodeHttp, SystemClock, UnavailableSecretStore,
  nodeDuckDBDriver, resolveExtensionDirectory,
} from '@datera/node-runtime';
import { serveStdio, type ServerInfo } from './mcp-stdio.js';
import { serveHttp } from './http-server.js';

export interface CliOptions {
  readonly mcp: boolean;
  readonly workspace: string | null;
  readonly httpPort: number | null;
  readonly host: string | null;
  readonly token: string | null;
  readonly help: boolean;
}

export const VERSION = '0.1.0';
const INFO: ServerInfo = { name: 'datera', version: VERSION };

export function parseArgs(argv: readonly string[]): CliOptions {
  const options = {
    mcp: false, workspace: null as string | null, httpPort: null as number | null,
    host: null as string | null, token: null as string | null, help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--mcp') options.mcp = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--workspace' && next !== undefined) { options.workspace = next; i += 1; }
    else if (arg === '--http' && next !== undefined) { options.httpPort = Number(next); i += 1; }
    else if (arg === '--host' && next !== undefined) { options.host = next; i += 1; }
    else if (arg === '--token' && next !== undefined) { options.token = next; i += 1; }
  }

  return options;
}

export const USAGE = `datera — serve a Datera workspace over MCP and a local API

  datera --mcp --workspace <path>          MCP over stdio (for Claude Desktop, Cursor…)
  datera --http <port> --workspace <path>  MCP + REST over HTTP on localhost
  datera --http <port> --host 0.0.0.0 --token <token>
                                           Reachable beyond this machine. A token is
                                           required for any non-loopback host.

Everything is read-only unless a write grant exists on a dataset, and a granted
write is only ever *proposed* over the wire — a human confirms it in Datera.
`;

/**
 * Open a workspace for a headless host.
 *
 * `UnavailableSecretStore`, deliberately: a CLI has no OS keychain session, so rather
 * than inventing plaintext storage it refuses to hold credentials at all. Database
 * passwords and model keys therefore have to come from the environment for a server
 * host, which is what spec §9 and §14.1 already specify.
 */
export async function openWorkspace(workspacePath: string): Promise<Datera> {
  return Datera.open({
    workspacePath,
    driver: nodeDuckDBDriver(),
    ports: {
      fs: new NodeFileSystem(),
      clock: new SystemClock(),
      // stderr, never stdout: stdout carries the MCP protocol.
      logger: new ConsoleLogger({ minLevel: 'info' }),
      secrets: new UnavailableSecretStore(),
      http: new NodeHttp(),
    },
    extensionDirectory: resolveExtensionDirectory(process.cwd()),
    appVersion: VERSION,
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);

  if (options.help || (!options.mcp && options.httpPort === null)) {
    process.stderr.write(USAGE);
    return options.help ? 0 : 1;
  }

  const workspace = options.workspace ?? process.env['DATERA_WORKSPACE'] ?? null;
  if (workspace === null) {
    process.stderr.write('A workspace is required: --workspace <path> or DATERA_WORKSPACE.\n');
    return 1;
  }

  const datera = await openWorkspace(workspace);
  const log = (message: string): void => void process.stderr.write(`${message}\n`);

  try {
    if (options.httpPort !== null) {
      const server = await serveHttp({
        datera,
        info: INFO,
        port: options.httpPort,
        ...(options.host === null ? {} : { host: options.host }),
        ...(options.token === null ? {} : { token: options.token }),
        log,
      });

      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => void server.close().then(resolve));
        process.on('SIGTERM', () => void server.close().then(resolve));
      });
      return 0;
    }

    log(`Datera MCP (stdio) · workspace ${workspace}`);
    await serveStdio({ datera, info: INFO, stdin: process.stdin, stdout: process.stdout, log });
    return 0;
  } finally {
    await datera.close();
  }
}
