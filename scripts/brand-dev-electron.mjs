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
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'Datera';
const BUNDLE_DIR = 'Datera.app';
const ICON = 'datera.icns';
/**
 * Its own identifier, not Electron's.
 *
 * LaunchServices keys records by bundle identifier, and every unpatched Electron.app on
 * the machine claims `com.github.Electron`. With a collision it is free to resolve the
 * name from whichever record it likes — which is why the Dock kept saying "Electron" even
 * with this bundle's own record reading "Datera".
 *
 * `.dev` distinguishes it from the packaged app, so the two never shadow each other.
 */
const BUNDLE_ID = 'app.datera.desktop.dev';

if (process.platform !== 'darwin') {
  console.log('brand-dev-electron: not macOS, nothing to do.');
  process.exit(0);
}

/**
 * The bundle is renamed on disk too, not just relabelled inside.
 *
 * The Dock tooltip for a running app comes from the bundle's *file name*, which is why it
 * kept saying "Electron" after CFBundleName, CFBundleDisplayName, the identifier and the
 * LaunchServices record all said Datera — every one of those was necessary, and none of
 * them was the tooltip.
 *
 * Renaming means the electron package's own path.txt has to be rewritten to match, since
 * that is how `require('electron')` and Playwright find the binary.
 */
function renameBundle(packageDir, current) {
  const target = join(dirname(current), BUNDLE_DIR);
  if (current === target) return { path: target, renamed: false };

  renameSync(current, target);

  const pathFile = join(packageDir, 'path.txt');
  const original = readFileSync(pathFile, 'utf8').trim();
  writeFileSync(pathFile, [BUNDLE_DIR, ...original.split('/').slice(1)].join('/'));

  return { path: target, renamed: true };
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

const packageDir = findPackageDir();
const { path: bundlePath, renamed } =
  packageDir === null ? { path: bundle, renamed: false } : renameBundle(packageDir, bundle);

const plist = join(bundlePath, 'Contents', 'Info.plist');
const resources = join(bundlePath, 'Contents', 'Resources');
const source = join(root, 'apps/desktop/build/icon.icns');

// A rename always re-registers: LaunchServices keys records by path, so the old one
// still points at a bundle that is no longer there.
if (
  !renamed &&
  readKey('CFBundleName') === APP_NAME &&
  readKey('CFBundleIdentifier') === BUNDLE_ID &&
  existsSync(join(resources, ICON))
) {
  console.log(`brand-dev-electron: already branded (${bundlePath}).`);
  process.exit(0);
}

copyFileSync(source, join(resources, ICON));
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  execFileSync('plutil', ['-replace', key, '-string', APP_NAME, plist]);
}
execFileSync('plutil', ['-replace', 'CFBundleIconFile', '-string', ICON, plist]);
execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, plist]);

// The Dock caches by bundle path and mtime; touching the bundle is what makes it re-read.
execFileSync('touch', [bundlePath]);

// And LaunchServices caches independently of that, so it is told explicitly. Without
// this the old record survives and the tile keeps the old name.
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework' +
  '/Support/lsregister';
if (existsSync(lsregister)) {
  try {
    execFileSync(lsregister, ['-f', bundlePath], { stdio: 'ignore' });
  } catch {
    // Best effort: a stale tooltip is worth reporting, not worth failing a launch over.
  }
}

console.log(`brand-dev-electron: branded ${bundlePath} as ${APP_NAME}.`);

function findPackageDir() {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  try {
    return dirname(require.resolve('electron/package.json'));
  } catch {
    return null;
  }
}

function findBundle() {
  const packageDir = findPackageDir();
  if (packageDir === null) return null;

  const pathFile = join(packageDir, 'path.txt');
  if (!existsSync(pathFile)) return null;

  // path.txt holds e.g. "Electron.app/Contents/MacOS/Electron" — the bundle is the first
  // segment, so this keeps working if the layout inside it ever changes.
  const first = readFileSync(pathFile, 'utf8').trim().split('/')[0];
  if (first === undefined || !first.endsWith('.app')) return null;

  const candidate = join(packageDir, 'dist', first);
  return existsSync(candidate) ? candidate : null;
}

function readKey(key) {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
