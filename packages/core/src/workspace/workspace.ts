import { asDateraError, DateraError } from '../errors.js';
import type { FileSystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/paths.js';

export const WORKSPACE_MANIFEST = 'workspace.json';
export const WORKSPACE_DATABASE = 'workspace.duckdb';
export const WORKSPACE_FORMAT_VERSION = 1;

/**
 * The on-disk manifest (decision D-05).
 *
 * The workspace is a plain directory — a manifest plus a DuckDB file — so that copying
 * the directory is sufficient to move it, including to a Datera Server via
 * `DATERA_WORKSPACE`. That makes the layout a cross-repo contract, which is why the
 * format version is written down and checked rather than assumed.
 */
export interface WorkspaceManifest {
  readonly formatVersion: number;
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** The Datera version that created the workspace. Provenance, for diagnosing upgrades. */
  readonly createdBy: string;
}

export interface WorkspacePaths {
  readonly root: string;
  readonly manifestPath: string;
  readonly databasePath: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    manifestPath: joinPath(root, WORKSPACE_MANIFEST),
    databasePath: joinPath(root, WORKSPACE_DATABASE),
  };
}

export async function readManifest(
  fs: FileSystemPort,
  paths: WorkspacePaths,
): Promise<WorkspaceManifest | null> {
  if (!(await fs.exists(paths.manifestPath))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readTextFile(paths.manifestPath));
  } catch (e) {
    throw asDateraError(e, 'WORKSPACE_FORMAT_UNSUPPORTED', 'workspace.json is not valid JSON', {
      manifestPath: paths.manifestPath,
    });
  }

  const manifest = parsed as WorkspaceManifest;
  if (typeof manifest.formatVersion !== 'number') {
    throw new DateraError(
      'WORKSPACE_FORMAT_UNSUPPORTED',
      'workspace.json is missing formatVersion',
      { manifestPath: paths.manifestPath },
    );
  }
  if (manifest.formatVersion > WORKSPACE_FORMAT_VERSION) {
    throw new DateraError(
      'WORKSPACE_FORMAT_UNSUPPORTED',
      `This workspace was written by a newer Datera (format ${manifest.formatVersion}; this build understands ${WORKSPACE_FORMAT_VERSION}). Upgrade Datera to open it.`,
      { manifestPath: paths.manifestPath, formatVersion: manifest.formatVersion },
    );
  }
  return manifest;
}

export async function writeManifest(
  fs: FileSystemPort,
  paths: WorkspacePaths,
  manifest: WorkspaceManifest,
): Promise<void> {
  await fs.writeTextFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Open an existing workspace directory or create one. Returns the manifest either way. */
export async function openOrCreateWorkspace(
  fs: FileSystemPort,
  root: string,
  makeId: () => string,
  now: () => Date,
  createdBy: string,
  name?: string,
): Promise<{ paths: WorkspacePaths; manifest: WorkspaceManifest; created: boolean }> {
  const paths = workspacePaths(root);
  await fs.mkdirp(root);

  const existing = await readManifest(fs, paths);
  if (existing !== null) {
    return { paths, manifest: existing, created: false };
  }

  const manifest: WorkspaceManifest = {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    id: makeId(),
    name: name ?? 'Workspace',
    createdAt: now().toISOString(),
    createdBy,
  };
  await writeManifest(fs, paths, manifest);
  return { paths, manifest, created: true };
}
