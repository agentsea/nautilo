import { defineConfig } from "vitest/config";

/**
 * Integration tests for `@nautilo/workbench-components` — currently the
 * bundle-size guard, which reads `dist/runtime.js` and so requires `tsup`
 * to have run first. Driven by `bun run test:integration`, which chains
 * `tsup && vitest run --config vitest.integration.config.ts`. Kept out of
 * `test:unit` (which would otherwise fail on a fresh checkout before
 * anyone has built anything).
 */
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: false,
    setupFiles: ["./tests/setup.ts"],
    env: {
      NODE_ENV: "production",
    },
  },
});
