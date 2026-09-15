import type {
  ClockPort,
  FileStat,
  FileSystemPort,
  LogFields,
  LoggerPort,
  LogLevel,
  Ports,
  SecretStorePort,
} from '@datera/core';
import { NodeFileSystem, SystemClock } from '@datera/node-runtime';

/** Deterministic clock: timestamps and durations are inputs to tests, not sources of flake. */
export class FakeClock implements ClockPort {
  private wall: number;
  private mono = 0;

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.wall = new Date(startIso).getTime();
  }

  now(): Date {
    return new Date(this.wall);
  }

  monotonicMs(): number {
    return this.mono;
  }

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
}

export interface CapturedLog {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * Captures log output so a test can assert on what was NOT logged.
 *
 * That is its main purpose: P1-20 asserts no credential ever reaches the log stream, and
 * you cannot assert absence against a logger that writes to stderr and forgets.
 */
export class CapturingLogger implements LoggerPort {
  readonly entries: CapturedLog[] = [];

  log(level: LogLevel, message: string, fields?: LogFields): void {
    this.entries.push({ level, message, fields: fields ?? {} });
  }

  /** Every log line serialised — the haystack for "this string must not appear". */
  serialise(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * An in-memory SecretStore.
 *
 * Tests must never write to the developer's real keychain — it would prompt, it would
 * persist between runs, and it would make CI depend on a desktop session. This behaves
 * like a working store so the credential paths are still exercised.
 */
export class InMemorySecretStore implements SecretStorePort {
  private readonly values = new Map<string, string>();

  constructor(private available = true) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.available) {
      throw new Error('Secret store unavailable');
    }
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** Inspect what was stored — used to assert the credential went here and nowhere else. */
  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.values);
  }
}

/** Records every path handed to a write operation, to prove sources are never among them. */
export class RecordingFileSystem implements FileSystemPort {
  readonly writes: string[] = [];
  readonly reads: string[] = [];

  constructor(private readonly inner: FileSystemPort = new NodeFileSystem()) {}

  async exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  async stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path);
  }

  async mkdirp(path: string): Promise<void> {
    this.writes.push(path);
    return this.inner.mkdirp(path);
  }

  async readTextFile(path: string): Promise<string> {
    this.reads.push(path);
    return this.inner.readTextFile(path);
  }

  async writeTextFile(path: string, contents: string): Promise<void> {
    this.writes.push(path);
    return this.inner.writeTextFile(path, contents);
  }
}

export interface TestPorts extends Ports {
  readonly fs: RecordingFileSystem;
  readonly clock: FakeClock;
  readonly logger: CapturingLogger;
  readonly secrets: InMemorySecretStore;
}

export function testPorts(options: { realClock?: boolean } = {}): TestPorts {
  return {
    fs: new RecordingFileSystem(),
    clock: options.realClock === true ? (new SystemClock() as unknown as FakeClock) : new FakeClock(),
    logger: new CapturingLogger(),
    secrets: new InMemorySecretStore(),
  };
}
