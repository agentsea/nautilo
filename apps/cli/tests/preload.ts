/**
 * CLI test preload: surface unhandled errors (Bun exits with their count even when
 * all tests pass) and reset process.exitCode between tests so handler "exit 2"
 * assertions do not leak into the runner exit code.
 *
 * IMPORTANT: reset to 0, not undefined. CLI command handlers set
 * `process.exitCode = 2` as a side effect on their error paths. On Linux, Bun's
 * test-file ordering can leave a *passing* test's leaked 2 as the final process
 * exit value, turning a 0-failure run into a CI failure. Assigning `undefined`
 * does NOT override that leaked 2; assigning 0 does. Genuine test failures still
 * exit non-zero because Bun forces that from its own failure counter,
 * independent of process.exitCode.
 */
import { afterAll, afterEach } from "bun:test";

process.on("unhandledRejection", (reason, promise) => {
  console.error("[cli test preload] unhandledRejection:", reason);
  console.error("[cli test preload] promise:", promise);
});

process.on("uncaughtException", (err) => {
  console.error("[cli test preload] uncaughtException:", err);
});

afterEach(() => {
  process.exitCode = 0;
});

afterAll(() => {
  process.exitCode = 0;
});
