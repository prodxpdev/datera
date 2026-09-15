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
}
