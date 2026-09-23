import type { Datera } from '@datera/core';
import { serveHttp, type RunningServer } from '@datera/cli';
import type { ServingStatus } from '../shared/contract.js';

/**
 * The app as the host that serves agents (§8).
 *
 * DuckDB allows a single writer. An agent launching `datera --mcp` against the workspace
 * the desktop app is holding gets a lock error, so the stdio config Settings → Serving
 * generates could not be used without quitting the app first — which is a choice between
 * an agent and the app, not a way to use both. With the app hosting the listener, one
 * process holds the workspace and the agent sees exactly the data the user is looking at,
 * with every served request landing in the same Activity view.
 *
 * The listener itself is `serveHttp` from the CLI, unchanged: the same handlers, the same
 * guards, the same loopback-and-token posture. A second implementation of the protocol
 * here is exactly how a host ends up enforcing something subtly different from the one
 * the tests cover.
 */
export class Serving {
  private server: RunningServer | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly core: () => Datera,
    private readonly version: string,
    private readonly log: (message: string) => void,
  ) {}

  async status(): Promise<ServingStatus> {
    const preference = await this.core().getServingPreference();
    if (this.server === null) {
      return {
        running: false,
        port: preference.port,
        ...(this.lastError === null ? {} : { error: this.lastError }),
      };
    }
    return {
      running: true,
      port: this.server.port,
      url: this.server.url,
      token: await this.core().servingToken(),
    };
  }

  /** Start, and remember that this workspace is served so a restart resumes it. */
  async start(port?: number): Promise<ServingStatus> {
    const preference = await this.core().setServingPreference({
      enabled: true,
      ...(port === undefined ? {} : { port }),
    });
    return this.listen(preference.port);
  }

  async stop(): Promise<ServingStatus> {
    await this.core().setServingPreference({ enabled: false });
    await this.shutdown();
    return this.status();
  }

  /**
   * Bring the listener up if the workspace says it should be, at launch.
   *
   * A failure here is recorded and shown, never thrown: the app opening is not
   * conditional on a port being free.
   */
  async resume(): Promise<void> {
    const preference = await this.core().getServingPreference();
    if (!preference.enabled) return;
    await this.listen(preference.port);
  }

  async rotate(): Promise<ServingStatus> {
    await this.core().rotateServingToken();
    // The running server captured the old token when it started, so it has to be
    // restarted — otherwise rotating would report a new token that nothing accepts.
    if (this.server !== null) {
      await this.shutdown();
      const preference = await this.core().getServingPreference();
      return this.listen(preference.port);
    }
    return this.status();
  }

  async shutdown(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) await server.close();
  }

  private async listen(port: number): Promise<ServingStatus> {
    await this.shutdown();
    this.lastError = null;

    try {
      const token = await this.core().servingToken();
      this.server = await serveHttp({
        datera: this.core(),
        info: { name: 'datera', version: this.version },
        port,
        // Loopback, always. Serving beyond this machine is a different decision with
        // different consequences, and it is not one to make from a toggle.
        host: '127.0.0.1',
        token,
        log: this.log,
      });
      this.log(`serving on ${this.server.url}`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log(`could not serve: ${this.lastError}`);
    }

    return this.status();
  }
}
