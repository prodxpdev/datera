/**
 * @datera/cli — the `datera` binary.
 *
 * A third host over the core, alongside the desktop app and (privately) Datera Server.
 * It adds transports and nothing else: every rule about what may be read, written or
 * joined lives in the core and applies identically here.
 */
export { serveStdio, handleRpc } from './mcp-stdio.js';
export type { JsonRpcRequest, JsonRpcResponse, ServerInfo, StdioOptions } from './mcp-stdio.js';
export { serveHttp } from './http-server.js';
export type { HttpServeOptions, RunningServer } from './http-server.js';
export { openWorkspace, parseArgs, main } from './main.js';
export type { CliOptions } from './main.js';
