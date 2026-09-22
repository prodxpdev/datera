import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

/**
 * Invariant §1.1 / acceptance §12.1, as a reusable assertion.
 *
 * "Datera did not modify my file" is the promise the entire product rests on, so it is
 * checked three ways rather than one: content hash (did the bytes change), byte length
 * (a cheap independent check that catches truncation), and mtime (did anything *touch*
 * the file, even writing identical bytes).
 *
 * mtime matters on its own. A rewrite with identical content leaves the hash unchanged
 * but is still a write, and a tool that rewrites your source file is not read-only no
 * matter how careful its content handling is.
 */
export interface FileFingerprint {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export async function fingerprintFile(path: string): Promise<FileFingerprint> {
  const [bytes, stats] = await Promise.all([readFile(path), stat(path)]);
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

export async function fingerprintFiles(paths: readonly string[]): Promise<readonly FileFingerprint[]> {
  return Promise.all(paths.map(fingerprintFile));
}

export interface FingerprintDifference {
  readonly path: string;
  readonly field: 'sha256' | 'size' | 'mtimeMs';
  readonly before: string | number;
  readonly after: string | number;
}

/** Compare two fingerprints and describe every difference. Empty means unchanged. */
export function diffFingerprints(
  before: FileFingerprint,
  after: FileFingerprint,
): readonly FingerprintDifference[] {
  const differences: FingerprintDifference[] = [];
  if (before.sha256 !== after.sha256) {
    differences.push({ path: before.path, field: 'sha256', before: before.sha256, after: after.sha256 });
  }
  if (before.size !== after.size) {
    differences.push({ path: before.path, field: 'size', before: before.size, after: after.size });
  }
  if (before.mtimeMs !== after.mtimeMs) {
    differences.push({ path: before.path, field: 'mtimeMs', before: before.mtimeMs, after: after.mtimeMs });
  }
  return differences;
}

export function describeDifferences(differences: readonly FingerprintDifference[]): string {
  return differences
    .map((d) => `${d.path}: ${d.field} changed from ${String(d.before)} to ${String(d.after)}`)
    .join('; ');
}

/**
 * Run `work` and assert that none of `paths` changed.
 *
 * Returns the differences instead of asserting directly so the caller's test framework
 * produces the failure message. The negative-control test in the suite deliberately
 * mutates a file through this helper to prove the check can actually fail — an invariant
 * assertion that has never failed proves nothing.
 */
export async function withUnchangedFiles<T>(
  paths: readonly string[],
  work: () => Promise<T>,
): Promise<{ result: T; differences: readonly FingerprintDifference[] }> {
  const before = await fingerprintFiles(paths);
  const result = await work();
  const after = await fingerprintFiles(paths);

  const differences = before.flatMap((b, i) => {
    const a = after[i];
    return a === undefined ? [] : diffFingerprints(b, a);
  });

  return { result, differences };
}
