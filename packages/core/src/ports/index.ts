export type { FileSystemPort, FileStat } from './filesystem.js';
export type { ClockPort } from './clock.js';
export type { LoggerPort, LogLevel, LogFields } from './logger.js';
export { nullLogger } from './logger.js';
export type { SecretStorePort } from './secrets.js';
export type { HttpPort, HttpRequest, HttpResponse } from './http.js';
export type {
  LocalLlmPort, LocalModelStatus, LocalGenerateRequest, LocalGenerateResult, DownloadProgress,
} from './llm.js';
export { OfflineHttp } from './http.js';
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
import type { HttpPort } from './http.js';
import type { LocalLlmPort } from './llm.js';

/** Everything a host must supply for the core to run. */
export interface Ports {
  readonly fs: FileSystemPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  readonly secrets: SecretStorePort;
  /**
   * Optional. A host that omits it gets `OfflineHttp`, so the default posture is "no
   * network" and reaching it is a deliberate act by the host rather than an accident.
   */
  readonly http?: HttpPort | undefined;
  /**
   * Optional. Supplies the bundled tier (§9 tier 1). A host without it simply has no
   * bundled models — the tier disappears from the picker rather than failing at call
   * time, because a model that cannot run should not be offered.
   */
  readonly llm?: LocalLlmPort | undefined;
}
