export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isDirectory: boolean;
}

/**
 * The core never touches a filesystem directly (spec §1.7). Hosts supply this.
 *
 * Note what is absent: there is no `deleteFile`, and `writeFile` exists only so the
 * workspace directory can be created and `workspace.json` written. Nothing in the core
 * calls a write path with a *source* path — that is invariant §1.2, enforced by the fact
 * that source paths only ever reach `exists` and `stat`.
 */
export interface FileSystemPort {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  mkdirp(path: string): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;

  /**
   * Read one named entry out of a zip container, as text. Null when absent.
   *
   * Optional, because it is the only thing here a host might reasonably not have:
   * decompressing a zip member needs an inflate implementation, and the core has none by
   * construction (§1.7). A host that omits it simply cannot enumerate the sheets in an
   * .xlsx — that degrades to "connect the first sheet", which is where the product
   * already was, rather than to an error.
   *
   * Generic rather than an `.xlsx`-shaped method: an Office file is a zip, and so are
   * several other formats worth reading later. A port method named after one caller ages
   * badly.
   */
  readZipEntry?(path: string, entry: string): Promise<string | null>;
}
