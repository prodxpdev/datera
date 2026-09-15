/**
 * @datera/testkit — fixtures, invariant assertions, and fake ports.
 *
 * Private to this repo. It exists so the §12.1 byte-identity assertion and the egress
 * guard are written once and used by every suite, rather than re-implemented per test
 * with subtly different strictness.
 */
export {
  fingerprintFile,
  fingerprintFiles,
  diffFingerprints,
  describeDifferences,
  withUnchangedFiles,
} from './byte-identity.js';
export type { FileFingerprint, FingerprintDifference } from './byte-identity.js';

export {
  fingerprintAttachedDatabase,
  diffDatabaseFingerprints,
  queryThrough,
} from './db-identity.js';
export type { DatabaseFingerprint, TableFingerprint, DatabaseDifference } from './db-identity.js';

export { EgressGuard, EgressBlockedError, withEgressBlocked } from './egress-guard.js';
export type { EgressAttempt } from './egress-guard.js';

export { generateFixtures, fixturePaths, defaultFixtureRoot, LARGE_FIXTURE_ROWS } from './fixtures.js';
export type { FixturePaths } from './fixtures.js';

export { writeXlsx } from './xlsx-writer.js';
export type { Sheet } from './xlsx-writer.js';

export {
  FakeClock,
  CapturingLogger,
  InMemorySecretStore,
  RecordingFileSystem,
  testPorts,
} from './fake-ports.js';
export type { TestPorts, CapturedLog } from './fake-ports.js';

export {
  openTestWorkspace,
  sequentialIds,
  repoRoot,
  stagedExtensionDirectory,
} from './harness.js';
export type { TestWorkspace, OpenTestWorkspaceOptions } from './harness.js';
