import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The lint half of the core purity guard (P1-03).
 *
 * The test in packages/core/test/purity.test.ts is the real enforcement — it runs in CI and
 * cannot be disabled with a comment. This rule exists so a violation is caught in the
 * editor, before it is written, rather than at the end of a test run.
 */
const CORE_FORBIDDEN = [
  { name: 'electron', message: 'The core must not depend on Electron (invariant §1.7). Put it in apps/desktop.' },
  { name: '@duckdb/node-api', message: 'The core reaches DuckDB through the driver port. The Node driver lives in @datera/node-runtime.' },
  { name: 'node:fs', message: 'The core uses FileSystemPort, so a browser/wasm host can satisfy it (spec §2a).' },
  { name: 'node:fs/promises', message: 'The core uses FileSystemPort, so a browser/wasm host can satisfy it (spec §2a).' },
  { name: 'node:path', message: 'Use core/src/util/paths.ts — the core carries no assumption about host path semantics.' },
  { name: 'node:http', message: 'The core is not a server.' },
  { name: 'node:https', message: 'The core is not a server.' },
  { name: 'node:net', message: 'The core does not open sockets.' },
  { name: 'node:child_process', message: 'The core does not spawn processes.' },
  { name: 'node:os', message: 'Host-specific. Pass what you need through a port.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/vendor/**', 'fixtures/**', '*.html'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: CORE_FORBIDDEN, patterns: ['**/apps/**', '@datera/node-runtime'] }],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.mjs', 'scripts/**'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  },
  {
    // The egress guard captures `this` because it installs plain functions onto Node's
    // networking prototypes, where `this` is already bound to the socket. An arrow
    // function would break the very thing it is patching.
    files: ['packages/testkit/src/egress-guard.ts'],
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
);
