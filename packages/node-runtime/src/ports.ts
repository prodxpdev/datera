import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ClockPort,
  FileStat,
  FileSystemPort,
  LogFields,
  LoggerPort,
  LogLevel,
  SecretStorePort,
} from '@datera/core';

export class NodeFileSystem implements FileSystemPort {
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch {
      return null;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async readTextFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    // performance.now() rather than Date.now(): durations must not move when the wall
    // clock does. A query that reports -40ms because NTP stepped is worse than no timing.
    return performance.now();
  }
}

export interface ConsoleLoggerOptions {
  readonly minLevel?: LogLevel;
  readonly sink?: (line: string) => void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON lines. Never log a credential or a data value. */
export class ConsoleLogger implements LoggerPort {
  private readonly minLevel: number;
  private readonly sink: (line: string) => void;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.minLevel = LEVEL_ORDER[options.minLevel ?? 'info'];
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
  }

  log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    this.sink(JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }));
  }
}

/**
 * A SecretStore for hosts with no protected storage.
 *
 * It refuses rather than degrading. Silently writing a database password to a JSON file
 * because the keychain was missing is precisely the failure decision D-06 exists to
 * prevent, so `isAvailable()` returns false and every write throws.
 */
export class UnavailableSecretStore implements SecretStorePort {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {
    throw new Error(
      'No protected credential store is available in this host. Datera will not store a credential in plaintext.',
    );
  }

  async delete(): Promise<void> {
    // Nothing was ever stored, so deletion is trivially complete.
  }
}
