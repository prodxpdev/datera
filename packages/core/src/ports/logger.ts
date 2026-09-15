export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

/**
 * Structured logging only. Never log a credential or a data value — the log is not a
 * transparency surface, the trace is (spec §1.4), and secrets leak through logs first.
 */
export interface LoggerPort {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export const nullLogger: LoggerPort = { log: () => {} };
