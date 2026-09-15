import { safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SecretStorePort } from '@datera/core';

/**
 * P1-20 / decision D-06 — credentials in OS-protected storage.
 *
 * Electron's `safeStorage` rather than a native keychain module: it is backed by the
 * macOS Keychain, Windows DPAPI, and libsecret/kwallet on Linux, and it ships with
 * Electron — no node-gyp, no ABI rebuild, one fewer native dependency to break on a
 * platform we do not test on.
 *
 * The ciphertext is written to a file beside the workspace. That file is useless without
 * the OS-held key, which is the point: the protection is the keychain, and the file is
 * just where the encrypted blob lives.
 *
 * It **refuses rather than degrades**. If `safeStorage` reports no encryption available —
 * a headless Linux box with no keyring, typically — writes throw. Silently falling back to
 * plaintext is the exact failure D-06 exists to prevent, and it is the kind of fallback
 * that is never noticed until it matters.
 */
export class SafeStorageSecretStore implements SecretStorePort {
  private cache: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    const all = await this.load();
    return all[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.assertAvailable();
    const all = await this.load();
    all[key] = value;
    await this.save(all);
  }

  async delete(key: string): Promise<void> {
    const all = await this.load();
    if (!(key in all)) return;
    await this.assertAvailable();
    delete all[key];
    await this.save(all);
  }

  private async assertAvailable(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new Error(
        'No OS credential store is available (macOS Keychain, Windows DPAPI, or a Linux ' +
          'keyring). Datera will not store a credential in plaintext. Connect without a ' +
          'password, or install/unlock a keyring such as gnome-keyring.',
      );
    }
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache !== null) return this.cache;

    let ciphertext: Buffer;
    try {
      ciphertext = await readFile(this.filePath);
    } catch {
      this.cache = {};
      return this.cache;
    }

    try {
      this.cache = JSON.parse(safeStorage.decryptString(ciphertext)) as Record<string, string>;
    } catch {
      // A store we cannot decrypt is treated as empty rather than fatal: the usual cause is
      // a restored backup or a changed OS user, and refusing to launch over it would be a
      // worse outcome than asking for the credential again.
      this.cache = {};
    }
    return this.cache;
  }

  private async save(all: Record<string, string>): Promise<void> {
    this.cache = all;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, safeStorage.encryptString(JSON.stringify(all)));
  }
}

export function secretStorePath(workspacePath: string): string {
  return join(workspacePath, 'credentials.enc');
}
