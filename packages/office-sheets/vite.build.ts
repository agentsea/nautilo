import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Declarations are NOT emitted here. `tsc -p tsconfig.build.json` runs after
// this build (see the package `build` script) — vite owns the JS, tsc owns
// the .d.ts. The order is load-bearing: vite's `emptyOutDir` would wipe
// declarations emitted first.
export default defineConfig(({ mode }) => {
  const browser = mode === 'browser';

  return {
    // Modified by Nautilo: both entries must run without ambient Node modules.
    // The headless entry is shared by browser persistence and server tools;
    // keeping it DOM-free does not make those browser callers Node runtimes.
    resolve: {
      alias: {
        assert: resolve(__dirname, 'src/compat/assert.ts'),
        util: resolve(__dirname, 'src/compat/util.ts'),
      },
    },
    build: {
      emptyOutDir: browser,
      lib: {
        entry: browser ? 'src/index.ts' : 'src/node.ts',
        name: browser ? 'nautilo-office-sheets' : 'nautilo-office-sheets-node',
        formats: ['es', 'cjs'],
        fileName: (format) =>
          browser
            ? format === 'cjs' ? 'browser.cjs' : 'browser.js'
            : format === 'cjs' ? 'node.cjs' : 'node.js',
      },
    },
  };
});
