/**
 * @datera/node-runtime — Node implementations of the core's ports.
 *
 * This package exists so that @datera/core can stay free of `node:fs`, `@duckdb/node-api`
 * and everything else host-specific (invariant §1.7). The desktop app, the `datera` CLI,
 * and `datera-server` all consume core through this.
 */
export { NodeDuckDBDriver, nodeDuckDBDriver } from './duckdb-driver.js';
export { NodeFileSystem, SystemClock, ConsoleLogger, UnavailableSecretStore } from './ports.js';
export type { ConsoleLoggerOptions } from './ports.js';
export { resolveExtensionDirectory } from './extension-dir.js';
