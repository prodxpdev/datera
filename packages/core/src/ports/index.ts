export type { FileSystemPort, FileStat } from './filesystem.js';
export type { ClockPort } from './clock.js';
export type { LoggerPort, LogLevel, LogFields } from './logger.js';
export { nullLogger } from './logger.js';
export type { SecretStorePort } from './secrets.js';
export type {
  DuckDBDriverPort,
  DuckDBHandlePort,
  DuckDBConnectionPort,
  DuckDBOpenOptions,
  ResultSet,
  ResultColumn,
  SqlParam,
  StatementKind,
  StatementClassification,
  ClassificationResult,
} from './duckdb.js';

import type { FileSystemPort } from './filesystem.js';
import type { ClockPort } from './clock.js';
import type { LoggerPort } from './logger.js';
import type { SecretStorePort } from './secrets.js';

/** Everything a host must supply for the core to run. */
export interface Ports {
  readonly fs: FileSystemPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  readonly secrets: SecretStorePort;
}
