import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type {
  ClockPort,
  FileStat,
  FileSystemPort,
  LogFields,
  LoggerPort,
  LogLevel,
  SecretStorePort,
} from '@datera/core';

/**
 * Zip's end-of-central-directory record and its entry headers.
 *
 * Implemented here rather than pulled in as a dependency: reading one small named entry
 * from a zip is a couple of hundred bytes of header parsing plus `inflateRaw`, and an
 * archive library would bring streaming, encryption and format variants this never needs.
 *
 * Only the two compression methods that actually occur in Office files are supported —
 * stored (0) and deflate (8). Anything else returns null rather than guessing.
 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findZipEntry(buffer: Buffer, entry: string): Buffer | null {
  // The end-of-central-directory record is last, but may be followed by a comment, so it
  // is searched for backwards from the end.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65_536; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return null;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === entry) {
      // The local header repeats the name and extra fields, and its extra length can
      // differ from the central one — so the data offset is computed from the local
      // header rather than assumed.
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);

      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}

export class NodeFileSystem implements FileSystemPort {
  /** One named entry from a zip container, as UTF-8 text. Null when it is not there. */
  async readZipEntry(path: string, entry: string): Promise<string | null> {
    try {
      const found = findZipEntry(await readFile(path), entry);
      return found === null ? null : found.toString('utf8');
    } catch {
      // Not a zip, unreadable, or corrupt. Callers treat absence as "no sheets", which is
      // the honest answer for all three.
      return null;
    }
  }

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
