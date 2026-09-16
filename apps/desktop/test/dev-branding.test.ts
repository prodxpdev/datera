import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * The development Electron bundle carries Datera's name and icon.
 *
 * A packaged build gets its own bundle and is right by construction. `electron .` runs
 * inside the Electron binary's bundle, whose Info.plist says "Electron" — that is what
 * the macOS Dock tile reads, and app.setName() cannot reach it. The menu bar and About
 * panel were fixed long before the Dock was, which is exactly how this went unnoticed.
 *
 * Asserted rather than assumed because the patch lives in node_modules: a reinstall
 * silently reverts it, and the only thing that makes that safe is the script being
 * idempotent and run on every `dev`.
 */
const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const script = join(repoRoot, 'scripts/brand-dev-electron.mjs');

function bundlePath(): string | null {
  const require = createRequire(join(repoRoot, 'apps/desktop/package.json'));
  const packageDir = dirname(require.resolve('electron/package.json'));
  const pathFile = join(packageDir, 'path.txt');
  if (!existsSync(pathFile)) return null;
  const first = readFileSync(pathFile, 'utf8').trim().split('/')[0] ?? '';
  const candidate = join(packageDir, 'dist', first);
  return existsSync(candidate) ? candidate : null;
}

function pathFileFor(): string {
  const require = createRequire(join(repoRoot, 'apps/desktop/package.json'));
  return join(dirname(require.resolve('electron/package.json')), 'path.txt');
}

function plistValue(plist: string, key: string): string {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
}

describe.runIf(process.platform === 'darwin')('development bundle branding', () => {
  const bundle = bundlePath();

  it('names the dev bundle Datera, so the Dock tile matches the packaged app', () => {
    expect(bundle).not.toBeNull();
    execFileSync('node', [script], { encoding: 'utf8' });

    const plist = join(bundle!, 'Contents', 'Info.plist');
    expect(plistValue(plist, 'CFBundleName')).toBe('Datera');
    expect(plistValue(plist, 'CFBundleDisplayName')).toBe('Datera');
    expect(plistValue(plist, 'CFBundleIconFile')).toBe('datera.icns');

    // Its own identifier, not com.github.Electron. LaunchServices keys records by
    // identifier, and every other unpatched Electron.app on a machine claims that one —
    // with a collision the Dock is free to take the name from whichever record it likes,
    // which is exactly what kept the tooltip saying "Electron" after the name was right.
    expect(plistValue(plist, 'CFBundleIdentifier')).toBe('app.datera.desktop.dev');
    expect(existsSync(join(bundle!, 'Contents', 'Resources', 'datera.icns'))).toBe(true);
  });

  it('names the bundle directory Datera.app, which is what the Dock tooltip reads', () => {
    // The last and least obvious layer. CFBundleName, CFBundleDisplayName, the bundle
    // identifier and the LaunchServices record all said Datera while the tooltip still
    // said Electron, because the tooltip comes from the bundle's file name.
    expect(bundle!.endsWith('/Datera.app')).toBe(true);
  });

  it('keeps path.txt pointing at the bundle it renamed', () => {
    // This file is how require('electron') and Playwright find the binary. Renaming the
    // directory without rewriting it breaks every launch, including the test suite's.
    const declared = readFileSync(pathFileFor(), 'utf8').trim();
    expect(declared.startsWith('Datera.app/')).toBe(true);
    expect(existsSync(join(dirname(bundle!), declared))).toBe(true);
  });

  it('leaves the executable name alone', () => {
    // The electron package's own path.txt points at this filename. Renaming it to fix a
    // label would break the launcher.
    const plist = join(bundle!, 'Contents', 'Info.plist');
    expect(plistValue(plist, 'CFBundleExecutable')).toBe('Electron');
    expect(existsSync(join(bundle!, 'Contents', 'MacOS', 'Electron'))).toBe(true);
  });

  it('is idempotent, because it runs on every dev launch', () => {
    const second = execFileSync('node', [script], { encoding: 'utf8' });
    expect(second).toMatch(/already branded/);
  });

  it('is wired into the scripts that launch the app', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts['dev']).toContain('brand-dev-electron');
    expect(manifest.scripts['start']).toContain('brand-dev-electron');
  });
});
