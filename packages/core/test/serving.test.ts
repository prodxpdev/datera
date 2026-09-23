import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { openTestWorkspace, testPorts, type TestWorkspace } from '@datera/testkit';

/**
 * Serving this workspace to an agent while it is open (§8).
 *
 * DuckDB allows one writer. An agent launching `datera --mcp` against the workspace the
 * desktop app is holding gets a lock error, so the config Settings → Serving hands out
 * could not actually be used without quitting the app first — which is not a serving
 * story, it is a choice between the two.
 *
 * The core owns the preference and the token; it does not own a server. Invariant §1.7
 * keeps an HTTP dependency out of the core, so the host starts and stops the listener
 * and asks here what it should be doing.
 */
describe('serving preference', () => {
  let ws: TestWorkspace;

  beforeEach(async () => {
    ws = await openTestWorkspace({ ports: testPorts() });
  });

  afterEach(async () => {
    await ws.dispose();
  });

  it('is off until asked for, because a listening socket is not a default', async () => {
    const preference = await ws.datera.getServingPreference();
    expect(preference.enabled).toBe(false);
  });

  it('remembers being turned on, so an agent survives a restart of the app', async () => {
    await ws.datera.setServingPreference({ enabled: true, port: 8899 });

    const reopened = await ws.reopen();
    const preference = await reopened.datera.getServingPreference();
    expect(preference.enabled).toBe(true);
    expect(preference.port).toBe(8899);
  });

  it('issues a token, because a socket without one is open to anything on the machine', async () => {
    const token = await ws.datera.servingToken();
    expect(token.length).toBeGreaterThanOrEqual(24);
  });

  it('keeps the same token, so a registered agent config does not go stale', async () => {
    const first = await ws.datera.servingToken();
    const second = await ws.datera.servingToken();
    expect(second).toBe(first);

    const reopened = await ws.reopen();
    expect(await reopened.datera.servingToken()).toBe(first);
  });

  it('rotates on request, and the old token stops being the answer', async () => {
    const first = await ws.datera.servingToken();
    const rotated = await ws.datera.rotateServingToken();

    expect(rotated).not.toBe(first);
    expect(await ws.datera.servingToken()).toBe(rotated);
  });

  it('refuses to issue one at all when there is nowhere protected to keep it', async () => {
    // D-06: a host that cannot provide real protection throws rather than quietly
    // degrading to plaintext. A token written beside the data would travel with any copy
    // of the workspace file, which is the one place it must never be.
    const ports = testPorts();
    ports.secrets.setAvailable(false);
    const fresh = await openTestWorkspace({ ports });

    await expect(fresh.datera.servingToken()).rejects.toThrow(/secret|protected|keychain/i);
    await fresh.dispose();
  });

  it('offers an HTTP config that carries the token it just issued', async () => {
    const token = await ws.datera.servingToken();
    const config = await ws.datera.connectConfig('claude-code', {
      url: 'http://127.0.0.1:8899',
      token,
    });

    expect(config.transport).toBe('http');
    expect(config.content).toContain(token);
  });
});
