import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    // DuckDB work and a 1M-row fixture are not fast. A short default timeout would make
    // the suite flaky on a cold CI runner, which teaches people to re-run rather than read.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Forks, not threads: the DuckDB native addon holds process-global state, and the
    // egress guard patches process-global networking. Neither is safe to share.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});
