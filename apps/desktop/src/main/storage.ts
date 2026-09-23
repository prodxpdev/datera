import { app, session } from 'electron';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What Datera has put on this machine, and removing it (§1.1, §1.8).
 *
 * "Your data stays on your machine" is the claim; the question people test it with is
 * "then show me what you stored, and let me delete it". No operating system answers that
 * — Windows and Linux both remove the *application* well and neither touches per-user
 * data, and macOS does not even do the application. So the app has to, because only the
 * app knows where it put things.
 *
 * Sizes are measured, never estimated. A panel that said "models: about 4GB" would be
 * guessing at the one number the user opened it for.
 */
export interface StorageItem {
  readonly id: StorageId;
  readonly label: string;
  /** What it is, and what removing it costs. */
  readonly description: string;
  readonly bytes: number;
  /**
   * Whether removing it loses work, as opposed to costing a re-download.
   *
   * The distinction the UI has to make loudly: clearing a cache is free, clearing the
   * workspace is not.
   */
  readonly destroysData: boolean;
}

export type StorageId = 'workspace' | 'models' | 'extensions' | 'caches';

/**
 * Electron's own scratch directories, which accumulate quietly and surprise people.
 *
 * Listed explicitly rather than "everything not otherwise named": a future directory this
 * file has not heard of should show up as unaccounted for, not be silently deleted by a
 * button labelled "caches".
 */
const CACHE_DIRECTORIES = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'blob_storage', 'Shared Dictionary', 'Trust Tokens', 'Trust Tokens-journal',
  'Local Storage', 'Session Storage', 'Network Persistent State',
];

/**
 * Where each thing lives.
 *
 * The workspace path is passed in rather than assumed to sit under userData, because it
 * does not always: DATERA_WORKSPACE moves it, and a panel that reported on a directory
 * the app is not actually using would be worse than no panel — it would show 0 bytes for
 * data that is plainly there, and delete the wrong thing when asked to clear it.
 */
function locations(workspacePath: string): Record<StorageId, readonly string[]> {
  const root = app.getPath('userData');
  return {
    workspace: [workspacePath],
    models: [join(root, 'models')],
    extensions: [join(root, 'duckdb-extensions')],
    caches: CACHE_DIRECTORIES.map((d) => join(root, d)),
  };
}

/** Bytes on disk, walked. Missing paths count as nothing rather than throwing. */
async function sizeOf(path: string): Promise<number> {
  let total = 0;
  let entry;
  try {
    entry = await stat(path);
  } catch {
    return 0;
  }
  if (!entry.isDirectory()) return entry.size;

  for (const child of await readdir(path, { withFileTypes: true })) {
    total += await sizeOf(join(path, child.name));
  }
  return total;
}

const DESCRIPTIONS: Record<StorageId, { label: string; description: string; destroysData: boolean }> = {
  workspace: {
    label: 'Your workspace',
    description:
      'The datasets you have connected, what you have taught Datera about them, and the ' +
      'record of every request. Removing this cannot be undone — export anything you want ' +
      'to keep first.',
    destroysData: true,
  },
  models: {
    label: 'Downloaded models',
    description:
      'Language models that run on this machine. Removing them frees the most space by ' +
      'far, and costs a download if you want them back.',
    destroysData: false,
  },
  extensions: {
    label: 'Database extensions',
    description:
      'The DuckDB extensions that read spreadsheets and connect to other databases. ' +
      'Datera fetches these once at setup and re-fetches them if they are missing.',
    destroysData: false,
  },
  caches: {
    label: 'Application caches',
    description:
      'Scratch files the window itself keeps. Safe to remove at any time; Datera rebuilds ' +
      'them as it goes.',
    destroysData: false,
  },
};

export async function storageUsage(workspacePath: string): Promise<readonly StorageItem[]> {
  const paths = locations(workspacePath);
  const items: StorageItem[] = [];

  for (const id of Object.keys(paths) as StorageId[]) {
    let bytes = 0;
    for (const path of paths[id]) bytes += await sizeOf(path);
    items.push({ id, bytes, ...DESCRIPTIONS[id] });
  }
  return items;
}

/** What a removal managed to do. */
export interface RemovalResult {
  /** Bytes still on disk afterwards — non-zero when something was in use. */
  readonly remaining: number;
}

/**
 * Remove one item, tolerating whatever is currently in use.
 *
 * A file the running process holds open cannot be unlinked on Windows, and Chromium keeps
 * handles on its own caches for as long as the window exists — so "clear caches" failed
 * with EPERM in the one situation that is entirely normal: doing it while the app is
 * running. Being unable to delete a file is therefore a fact to report, not an error; the
 * caller learns what is left and can say it goes on restart.
 *
 * The id is looked up in a fixed table rather than joined onto a path. A caller that could
 * name an arbitrary path here would be a delete-anything primitive reachable from the
 * renderer, which is exactly what the preload boundary exists to prevent.
 */
export async function removeStorage(id: string, workspacePath: string): Promise<RemovalResult> {
  const paths = locations(workspacePath);
  if (!Object.prototype.hasOwnProperty.call(paths, id)) {
    throw new Error(`Not something Datera stores: "${id}".`);
  }

  // Chromium's disk cache is Chromium's to clear. Asking it beats deleting files
  // underneath a live browser, which is how those handles come to be held in the first
  // place.
  //
  // `clearCache()` only. `clearStorageData()` also wipes localStorage, which is where the
  // window keeps state like whether first run has been dismissed — so clearing a cache
  // reset the app underneath the person who clicked it, and on Linux the first-run overlay
  // came back over the navigation. A cache clear must not be visible as anything but a
  // cache clear.
  if (id === 'caches') {
    try {
      await session.defaultSession.clearCache();
    } catch {
      // Best effort: the sweep below is the fallback, not the other way round.
    }
  }

  for (const path of paths[id as StorageId]) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (e) {
      // Only the "it is in use" family is survivable. Anything else is a real failure and
      // must surface rather than be reported as a partial success.
      const code = (e as { code?: string }).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') {
        throw e;
      }
    }
  }

  let remaining = 0;
  for (const path of paths[id as StorageId]) remaining += await sizeOf(path);
  return { remaining };
}

/**
 * The step Datera cannot take for itself.
 *
 * Every platform removes the application and none of them removes the data; this is the
 * other half of that. Saying it plainly is the difference between a complete answer and a
 * dead end — and on macOS in particular there is no uninstaller to point at, because
 * shipping one is not how Mac applications work.
 */
export function removalInstruction(): string {
  if (process.platform === 'darwin') {
    return 'Everything Datera stored is gone. To remove the application itself, quit Datera ' +
      'and drag Datera from your Applications folder to the Trash.';
  }
  if (process.platform === 'win32') {
    return 'Everything Datera stored is gone. To remove the application itself, quit Datera ' +
      'and use Add or remove programs in Windows Settings.';
  }
  return 'Everything Datera stored is gone. To remove the application itself, quit Datera ' +
    'and remove the package you installed — `sudo apt remove datera` for a .deb, or delete ' +
    'the AppImage file.';
}
