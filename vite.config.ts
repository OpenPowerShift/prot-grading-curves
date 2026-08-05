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
    /*
     * jsdom has no layout engine, and CodeMirror measures on any
     * dispatch that asks to scroll. `tests/setup.ts` supplies the two
     * `Range` methods it calls, which jsdom does not define -- without
     * them the measure throws inside a requestAnimationFrame callback,
     * every assertion still passes, and the run still exits non-zero.
     */
    setupFiles: ['tests/setup.ts'],
    include: ['tests/unit/**/*.spec.ts'],
    exclude: ['tests/visual/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      /*
       * `main.ts` is the three-line browser entry point, `examples.ts`
       * is a list of `?raw` imports Vite alone can resolve, and `.d.ts`
       * files declare rather than execute. None of the three can be
       * covered by a unit test, and leaving them in makes the figure
       * describe the build rather than the code.
       */
      exclude: ['src/main.ts', 'src/examples.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
      thresholds: { statements: 95, branches: 85, functions: 95, lines: 95 },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
