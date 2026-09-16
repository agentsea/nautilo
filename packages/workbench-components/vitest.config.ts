import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
    // `tests/integration/` holds build-output guards (e.g. bundle-size) that
    // require a `tsup` build to have run first. They are NOT unit tests and
    // are exercised via `bun run test:integration` in CI, not `test:unit`.
    exclude: ["node_modules/**", "dist/**", "tests/integration/**"],
    passWithNoTests: false,
    setupFiles: ["./tests/setup.ts"],
    env: {
      NODE_ENV: "production",
    },
  },
});
