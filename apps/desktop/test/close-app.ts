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

  const killed = new Promise<void>((resolve) => {
    setTimeout(() => {
      try {
        app.process().kill('SIGKILL');
      } catch {
        // Already gone, which is the outcome we wanted.
      }
      resolve();
    }, 15_000).unref();
  });

  await Promise.race([app.close().catch(() => undefined), killed]);
}
