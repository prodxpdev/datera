/**
 * Whether this workspace is served, and the token that guards it (§8).
 *
 * The core owns the *decision* and the credential; it does not own a listener. Invariant
 * §1.7 keeps an HTTP server out of the core, so a host asks what it should be doing and
 * starts or stops its own socket.
 *
 * This exists because DuckDB allows a single writer. An agent launching `datera --mcp`
 * against the workspace the desktop app is holding gets a lock error — so the stdio
 * config Settings → Serving hands out could not be used without quitting the app, which
 * is not a serving story but a choice between the two. When the app hosts the server,
 * one process holds the workspace and the agent sees exactly the data the user does.
 */

export interface ServingPreference {
  readonly enabled: boolean;
  readonly port: number;
}

/**
 * Loopback only, and a port well outside the range anything else claims by default.
 * Binding beyond loopback is a separate decision with a separate refusal, and it lives
 * in the host that actually binds.
 */
export const DEFAULT_SERVING: ServingPreference = { enabled: false, port: 8899 };

export const SERVING_SETTING = 'serving';
export const SERVING_TOKEN_KEY = 'serving-token';

export function parseServingPreference(raw: string | null): ServingPreference {
  if (raw === null) return DEFAULT_SERVING;
  try {
    const parsed = JSON.parse(raw) as Partial<ServingPreference>;
    const port = typeof parsed.port === 'number' && parsed.port > 0 && parsed.port < 65536
      ? parsed.port
      : DEFAULT_SERVING.port;
    return { enabled: parsed.enabled === true, port };
  } catch {
    // A malformed setting turns serving off rather than on. The failure that costs
    // nothing is the one where the socket does not open.
    return DEFAULT_SERVING;
  }
}

/**
 * A fresh token.
 *
 * Web Crypto rather than `node:crypto`: the core is host-neutral by construction (§1.7,
 * and §2a's browser/wasm path), and `getRandomValues` is the one CSPRNG available
 * everywhere it has to run. base64url so it survives a header, a URL and a JSON config
 * without escaping.
 */
export function generateServingToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
