import { defineConfig } from 'vitest/config';
import { guidePlugin } from './scripts/guide-plugin.js';

export default defineConfig({
  plugins: [guidePlugin()],
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@tc': '/src',
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/unit/**/*.spec.ts'],
    exclude: ['tests/visual/**/*.spec.ts'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
