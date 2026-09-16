import { defineConfig } from 'vite';

// Declarations are NOT emitted here. `tsc -p tsconfig.build.json` runs after
// this build (see the package `build` script) — vite owns the JS, tsc owns
// the .d.ts. The order is load-bearing: vite's `emptyOutDir` would wipe
// declarations emitted first.
export default defineConfig({
  build: {
    lib: {
      // Owned build outputs for the two supported runtime surfaces:
      //   - `./browser` (full editor; browser-only)
      //   - `./node` (data-model-only; backend/CLI/SSR safe — no DOM)
      entry: {
        browser: 'src/index.ts',
        node: 'src/node.ts',
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        if (entryName === 'node') {
          return format === 'cjs' ? 'node.cjs' : 'node.js';
        }
        return format === 'cjs' ? 'browser.cjs' : 'browser.js';
      },
    },
  },
});
