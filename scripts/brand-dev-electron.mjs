#!/usr/bin/env node
/**
 * Brands the development Electron bundle as Datera.
 *
 * On macOS the Dock tile takes its name and icon from the *running bundle's* Info.plist.
 * A packaged build has its own bundle and is correct already; `electron .` runs inside the
 * Electron binary's bundle, which says "Electron" — and no runtime call reaches it.
 * `app.setName()` fixes the menu bar and About panel only.
 *
 * So the dev bundle is patched in place. Three things make that acceptable rather than
 * reckless:
 *
 *   - it only ever writes inside node_modules, and refuses if the path it resolved is
 *     outside this repository;
 *   - it is idempotent, so running it on every `dev` costs nothing and a reinstall simply
 *     undoes it until the next run;
 *   - it changes presentation only. CFBundleExecutable is deliberately left alone: the
 *     electron package's own path.txt points at that filename, and renaming it would
 *     break the launcher to fix a label.
 *
 * A no-op off macOS, where none of this exists.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'Datera';
const ICON = 'datera.icns';

if (process.platform !== 'darwin') {
  console.log('brand-dev-electron: not macOS, nothing to do.');
  process.exit(0);
}

const bundle = findBundle();
if (bundle === null) {
  // Not fatal: a fresh checkout without install, or a platform layout we do not know.
  console.log('brand-dev-electron: no Electron.app found, skipping.');
  process.exit(0);
}

// Never write outside the repository, whatever a resolver handed back.
if (relative(root, bundle).startsWith('..')) {
  throw new Error(`refusing to modify ${bundle}: outside ${root}`);
}

const plist = join(bundle, 'Contents', 'Info.plist');
const resources = join(bundle, 'Contents', 'Resources');
const source = join(root, 'apps/desktop/build/icon.icns');

if (readName() === APP_NAME && existsSync(join(resources, ICON))) {
  console.log(`brand-dev-electron: already branded (${bundle}).`);
  process.exit(0);
}

copyFileSync(source, join(resources, ICON));
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  execFileSync('plutil', ['-replace', key, '-string', APP_NAME, plist]);
}
execFileSync('plutil', ['-replace', 'CFBundleIconFile', '-string', ICON, plist]);

// The Dock caches by bundle path and mtime; touching the bundle is what makes it re-read.
execFileSync('touch', [bundle]);

console.log(`brand-dev-electron: branded ${bundle} as ${APP_NAME}.`);

function findBundle() {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  let packageDir;
  try {
    packageDir = dirname(require.resolve('electron/package.json'));
  } catch {
    return null;
  }

  const pathFile = join(packageDir, 'path.txt');
  if (!existsSync(pathFile)) return null;

  // path.txt holds e.g. "Electron.app/Contents/MacOS/Electron" — the bundle is the first
  // segment, so this keeps working if the layout inside it ever changes.
  const first = readFileSync(pathFile, 'utf8').trim().split('/')[0];
  if (first === undefined || !first.endsWith('.app')) return null;

  const candidate = join(packageDir, 'dist', first);
  return existsSync(candidate) ? candidate : null;
}

function readName() {
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', plist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
