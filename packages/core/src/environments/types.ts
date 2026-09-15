/**
 * Environments — Local, and deployed Datera Servers (spec §10).
 *
 * The client is the "local dev" environment and doubles as the control-plane UI for
 * remote ones. This is **client-side only**: nothing here issues a token, enforces a
 * scope, or orchestrates a deploy. Those live in the private `datera-server` repo, and
 * keeping that line visible is why this module talks only to a server's public API.
 */

export type EnvironmentKind = 'local' | 'remote';

export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly kind: EnvironmentKind;
  /** Absent for the local environment. */
  readonly url?: string | undefined;
  /** The keychain entry holding this environment's token. Never the token. */
  readonly tokenKey?: string | undefined;
  readonly createdAt: string;
}

export interface EnvironmentStatus {
  readonly id: string;
  readonly name: string;
  readonly kind: EnvironmentKind;
  readonly url: string | null;
  readonly reachable: boolean;
  /** Present when unreachable — in words a person can act on. */
  readonly reason?: string | undefined;
}

export const LOCAL_ENVIRONMENT_ID = 'local';

export const environmentTokenKey = (id: string): string => `environment.token.${id}`;
