#!/usr/bin/env node
/** Builds main (ESM), preload (CJS), and the renderer bundle. */
import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const external = ['electron', '@datera/core', '@datera/node-runtime', '@duckdb/node-api', 'node:fs', 'node:fs/promises', 'node:path', 'node:os', 'node:url', 'node:net'];

await build({
  configFile: false,
  build: {
    outDir: resolve(root, 'dist/main'),
    emptyOutDir: true,
    ssr: true,
    target: 'node20',
    rollupOptions: {
      input: resolve(root, 'src/main/main.ts'),
      external: (id) => external.includes(id) || id.startsWith('node:'),
      output: { entryFileNames: 'main.js', format: 'es' },
    },
  },
});

await build({
  configFile: false,
  build: {
    outDir: resolve(root, 'dist/preload'),
    emptyOutDir: true,
    ssr: true,
    target: 'node20',
    rollupOptions: {
      input: resolve(root, 'src/preload/preload.ts'),
      external: ['electron'],
      // CommonJS: a sandboxed preload script cannot be an ES module.
      output: { entryFileNames: 'preload.cjs', format: 'cjs' },
    },
  },
});

await build({ configFile: resolve(root, 'vite.config.ts') });
console.log('desktop build complete');
