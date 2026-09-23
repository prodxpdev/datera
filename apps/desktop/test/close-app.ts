import type { ElectronApplication } from 'playwright';

/**
 * Shut an Electron app down, and do not wait forever for it.
 *
 * `app.close()` asks politely and can hang when the process is wedged — which is exactly
 * when a test most wants to finish. On a Linux CI runner this stalled a teardown hook for
 * four minutes after all four of its tests had passed, failing the suite on the way out.
 *
 * So: ask, wait a bounded time, then kill. A test process that outlives its run is a
 * worse outcome than an ungraceful exit, and the app under test is about to be discarded
 * either way.
 */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (app === undefined) return;

  const child = app.process();
  const killed = new Promise<void>((resolve) => {
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone, which is the outcome we wanted.
      }
      resolve();
    }, 15_000).unref();
  });

  await Promise.race([app.close().catch(() => undefined), killed]);

  // Then wait for it to actually be gone. Asking a process to die and deleting its
  // working directory in the next statement is a race: the kernel is still tearing the
  // process down, its children are still flushing, and `rm -rf` on the workspace fails
  // with ENOTEMPTY because something wrote into a directory mid-delete. That surfaced as
  // an unrelated-looking teardown failure on a loaded Linux runner.
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('exit', done);
      child.once('close', done);
      setTimeout(done, 10_000).unref();
    });
  }
}

/**
 * Delete a test workspace, tolerating a straggler.
 *
 * Even after the process is gone its helpers can take a moment, so a recursive delete can
 * still lose a race it will win immediately afterwards. Retried rather than ignored: a
 * cleanup that silently leaves gigabytes in /tmp is its own problem.
 */
export async function removeWorkspace(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw e;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  await rm(path, { recursive: true, force: true });
}
