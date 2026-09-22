import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Three separate builds, because the three contexts have genuinely different constraints:
 * the renderer is a browser bundle, main is Node/ESM, and preload must be CommonJS because
 * a sandboxed preload script cannot be an ES module.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
  },
});
