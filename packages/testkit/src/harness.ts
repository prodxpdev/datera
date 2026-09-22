import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Datera, type DateraOptions } from '@datera/core';
import { nodeDuckDBDriver } from '@datera/node-runtime';
import { testPorts, type TestPorts } from './fake-ports.js';

export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

export function stagedExtensionDirectory(): string {
  const fromEnv = process.env['DATERA_EXTENSION_DIR'];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  return join(repoRoot(), 'vendor', 'duckdb-extensions');
}

export interface TestWorkspace {
  readonly datera: Datera;
  readonly ports: TestPorts;
  readonly workspacePath: string;
  /** Close the instance and delete the temporary workspace directory. */
  dispose(): Promise<void>;
  /** Close and reopen against the same directory — the restart-persistence path. */
  reopen(): Promise<TestWorkspace>;
}

export interface OpenTestWorkspaceOptions {
  readonly workspacePath?: string;
  readonly ports?: TestPorts;
  readonly makeId?: () => string;
}

/** Deterministic ids, so catalog assertions do not depend on randomness. */
export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(4, '0')}`;
  };
}

export async function openTestWorkspace(
  options: OpenTestWorkspaceOptions = {},
): Promise<TestWorkspace> {
  const workspacePath = options.workspacePath ?? (await mkdtemp(join(tmpdir(), 'datera-ws-')));
  const ports = options.ports ?? testPorts();
  const makeId = options.makeId ?? sequentialIds();
  const temporary = options.workspacePath === undefined;

  const dateraOptions: DateraOptions = {
    workspacePath,
    driver: nodeDuckDBDriver(),
    ports,
    extensionDirectory: stagedExtensionDirectory(),
    makeId,
  };

  const datera = await Datera.open(dateraOptions);

  const workspace: TestWorkspace = {
    datera,
    ports,
    workspacePath,
    async dispose() {
      // Tolerant: a test that closes early — to read the database file, which Windows
      // will not open while it is held — still runs this in its teardown.
      await datera.close().catch(() => undefined);
      if (temporary) await rm(workspacePath, { recursive: true, force: true });
    },
    async reopen() {
      await datera.close();
      const reopened = await openTestWorkspace({ workspacePath, ports, makeId });
      // The reopened workspace owns cleanup of the directory this one created.
      return temporary ? withTemporaryCleanup(reopened, workspacePath) : reopened;
    },
  };

  return workspace;
}

function withTemporaryCleanup(workspace: TestWorkspace, path: string): TestWorkspace {
  return {
    ...workspace,
    async dispose() {
      await workspace.datera.close();
      await rm(path, { recursive: true, force: true });
    },
  };
}
