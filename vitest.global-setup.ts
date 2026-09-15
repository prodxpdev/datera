import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateFixtures } from './packages/testkit/dist/index.js';

const run = promisify(execFile);

/**
 * Runs once before the whole suite.
 *
 * Two jobs, both learned the hard way:
 *
 * 1. **Generate fixtures.** Tests assert on file mtimes, so every suite must see files this
 *    run created — a committed fixture with a decade-old mtime would make the §12.1
 *    byte-identity assertion pass for the wrong reason.
 *
 * 2. **Build the desktop bundle.** The Electron tests launch `apps/desktop`, which runs
 *    from `dist/`. Without this, a failed or forgotten build leaves a *stale* bundle in
 *    place and the tests quietly assert against old code — which is exactly how a startup
 *    crash and an extension-path bug both got past a green suite. Building here makes
 *    "the tests ran against the code I just wrote" a property of the harness rather than
 *    a thing to remember.
 */
export async function setup(): Promise<void> {
  // Compile first. `vitest run` on its own does not, so without this a suite can assert
  // against a stale packages/*/dist — which has already cost real debugging time once.
  // Making it part of setup means no invocation of the tests can skip it.
  try {
    await run('node', ['node_modules/typescript/bin/tsc', '-b'], { cwd: process.cwd() });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `TypeScript build failed, so the tests would have run against stale output.\n` +
        `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`,
      { cause: e },
    );
  }

  const paths = await generateFixtures();
  process.env.DATERA_FIXTURES = paths.root;

  try {
    await run('node', ['build.mjs'], { cwd: 'apps/desktop' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `The desktop build failed, so the Electron tests would have run against a stale bundle.\n` +
        `${err.stderr ?? ''}${err.stdout ?? ''}${err.message ?? ''}`,
      { cause: e },
    );
  }
}
