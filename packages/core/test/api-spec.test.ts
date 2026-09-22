import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_ENDPOINTS, apiEndpointsByGroup } from '@datera/core';
import { repoRoot } from '@datera/testkit';

/**
 * The API documentation must describe the API that exists (spec §8).
 *
 * Documentation written separately from an implementation drifts, usually just after the
 * release where someone changed a path. So this test reads the CLI's router and checks
 * the two agree — in both directions.
 */
describe('§8 the documented API matches the served one', () => {
  it('documents every route the server actually handles', async () => {
    const router = await readFile(
      join(repoRoot(), 'packages/cli/src/http-server.ts'),
      'utf8',
    );

    const served = [...router.matchAll(/url\.startsWith\('([^']+)'\)/g)].map((m) => m[1] as string);
    expect(served.length).toBeGreaterThan(4);

    const documented = new Set(API_ENDPOINTS.map((e) => e.path));
    const undocumented = served.filter((path) => !documented.has(path));

    expect(undocumented, `served but undocumented: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('documents nothing the server does not handle', async () => {
    const router = await readFile(
      join(repoRoot(), 'packages/cli/src/http-server.ts'),
      'utf8',
    );

    const missing = API_ENDPOINTS.filter((e) => !router.includes(`'${e.path}'`));
    expect(
      missing.map((e) => e.path),
      'documented but not served',
    ).toEqual([]);
  });

  it('marks only the health checks as unauthenticated', () => {
    const open = API_ENDPOINTS.filter((e) => !e.requiresAuth).map((e) => e.path);
    expect(open.sort()).toEqual(['/healthz', '/readyz']);
  });

  it('flags the endpoint that needs an explicit opt-in', () => {
    const push = API_ENDPOINTS.find((e) => e.path === '/api/push');
    expect(push?.requiresFlag).toBe('--allow-push');
  });

  it('gives every endpoint something copy-pasteable', () => {
    for (const endpoint of API_ENDPOINTS) {
      expect(endpoint.example.length, endpoint.path).toBeGreaterThan(10);
      expect(endpoint.returns.length, endpoint.path).toBeGreaterThan(5);
    }
  });

  it('groups endpoints without losing any', () => {
    const grouped = apiEndpointsByGroup().flatMap((g) => g.endpoints);
    expect(new Set(grouped.map((e) => e.path)).size).toBe(API_ENDPOINTS.length);
  });
});
