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
    // Capped rather than unbounded, and capped low. Eight suites now launch a real
    // Electron app — each opening DuckDB and loading four extensions — and four of those
    // starting at once starves each other badly enough that window creation times out.
    // That failure looks exactly like a product bug and is not one, which is the worst
    // kind of flake to leave in a suite.
    //
    // Two costs about forty seconds of wall clock and has been reliable. Raise it only
    // with evidence, not optimism.
    poolOptions: { forks: { singleFork: false, minForks: 1, maxForks: 2 } },
  },
});
