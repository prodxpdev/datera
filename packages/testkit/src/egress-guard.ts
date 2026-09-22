import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Fails a test on any outbound network attempt (decision D-12).
 *
 * This backs two claims that are otherwise unverifiable by inspection:
 *  - acceptance §12.8, that the bundled local model works with no network egress; and
 *  - P1-05, that connecting a source never triggers a silent extension download.
 *
 * It patches the primitives rather than watching for traffic, so an attempt is caught
 * even when nothing is listening and the connection would have failed anyway. A test that
 * passes because the network happened to be down is not evidence of anything.
 */
export interface EgressAttempt {
  readonly api: string;
  readonly target: string;
  readonly stack: string;
}

export class EgressBlockedError extends Error {
  constructor(attempt: EgressAttempt) {
    super(`Network egress blocked: ${attempt.api} -> ${attempt.target}`);
    this.name = 'EgressBlockedError';
  }
}

interface Saved {
  netConnect: typeof net.connect;
  netCreateConnection: typeof net.createConnection;
  socketConnect: typeof net.Socket.prototype.connect;
  tlsConnect: typeof tls.connect;
  httpRequest: typeof http.request;
  httpsRequest: typeof https.request;
  dnsLookup: typeof dns.lookup;
  dnsPromisesLookup: typeof dns.promises.lookup;
}

export class EgressGuard {
  readonly attempts: EgressAttempt[] = [];
  private saved: Saved | null = null;

  /** Localhost is allowed through when set — needed to test against DB containers. */
  constructor(private readonly allowLoopback = false) {}

  private record(api: string, target: string): void {
    const attempt: EgressAttempt = {
      api,
      target,
      stack: new Error('egress').stack ?? '',
    };
    this.attempts.push(attempt);
    throw new EgressBlockedError(attempt);
  }

  private isAllowed(target: string): boolean {
    if (!this.allowLoopback) return false;
    return /^(localhost|127\.0\.0\.1|::1|\[::1\])(:|$)/.test(target);
  }

  private check(api: string, target: string): void {
    if (this.isAllowed(target)) return;
    this.record(api, target);
  }

  install(): void {
    if (this.saved !== null) return;

    this.saved = {
      netConnect: net.connect,
      netCreateConnection: net.createConnection,
      socketConnect: net.Socket.prototype.connect,
      tlsConnect: tls.connect,
      httpRequest: http.request,
      httpsRequest: https.request,
      dnsLookup: dns.lookup,
      dnsPromisesLookup: dns.promises.lookup,
    };

    const guard = this;
    const describe = (args: readonly unknown[]): string => {
      const first = args[0];
      if (typeof first === 'string' || typeof first === 'number') {
        const second = args[1];
        return typeof second === 'string' ? `${String(second)}:${String(first)}` : String(first);
      }
      if (first !== null && typeof first === 'object') {
        const o = first as { host?: string; hostname?: string; port?: number | string; path?: string };
        const host = o.host ?? o.hostname ?? o.path ?? 'unknown';
        return o.port === undefined ? host : `${host}:${String(o.port)}`;
      }
      return 'unknown';
    };

    net.connect = function (...args: unknown[]): never {
      guard.check('net.connect', describe(args));
      throw new Error('unreachable');
    } as unknown as typeof net.connect;

    net.createConnection = net.connect;

    net.Socket.prototype.connect = function (...args: unknown[]): never {
      guard.check('net.Socket.connect', describe(args));
      throw new Error('unreachable');
    } as unknown as typeof net.Socket.prototype.connect;

    tls.connect = function (...args: unknown[]): never {
      guard.check('tls.connect', describe(args));
      throw new Error('unreachable');
    } as unknown as typeof tls.connect;

    http.request = function (...args: unknown[]): never {
      guard.check('http.request', describe(args));
      throw new Error('unreachable');
    } as unknown as typeof http.request;

    https.request = function (...args: unknown[]): never {
      guard.check('https.request', describe(args));
      throw new Error('unreachable');
    } as unknown as typeof https.request;

    dns.lookup = function (hostname: string, ...rest: unknown[]): never {
      guard.check('dns.lookup', hostname);
      void rest;
      throw new Error('unreachable');
    } as unknown as typeof dns.lookup;

    dns.promises.lookup = function (hostname: string): never {
      guard.check('dns.promises.lookup', hostname);
      throw new Error('unreachable');
    } as unknown as typeof dns.promises.lookup;
  }

  uninstall(): void {
    if (this.saved === null) return;
    net.connect = this.saved.netConnect;
    net.createConnection = this.saved.netCreateConnection;
    net.Socket.prototype.connect = this.saved.socketConnect;
    tls.connect = this.saved.tlsConnect;
    http.request = this.saved.httpRequest;
    https.request = this.saved.httpsRequest;
    dns.lookup = this.saved.dnsLookup;
    dns.promises.lookup = this.saved.dnsPromisesLookup;
    this.saved = null;
  }

  reset(): void {
    this.attempts.length = 0;
  }
}

/**
 * Run `work` with egress blocked, returning any attempts made.
 *
 * Note the honest limit: this patches Node's networking, so it cannot see a socket opened
 * from inside DuckDB's native code. That is exactly why extensions are staged ahead of
 * time and `autoinstall_known_extensions` is set to false — the native layer is prevented
 * from wanting the network rather than being policed after the fact.
 */
export async function withEgressBlocked<T>(
  work: () => Promise<T>,
  options: { allowLoopback?: boolean } = {},
): Promise<{ result: T; attempts: readonly EgressAttempt[] }> {
  const guard = new EgressGuard(options.allowLoopback ?? false);
  guard.install();
  try {
    const result = await work();
    return { result, attempts: [...guard.attempts] };
  } finally {
    guard.uninstall();
  }
}
