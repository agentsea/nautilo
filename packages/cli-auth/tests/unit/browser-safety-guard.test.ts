/**
 * Regression guard: CLI `openUrlInDefaultBrowser` MUST be a no-op
 * inside the test process. Several hooks (`useChangePassword`,
 * `useForgotPassword`, `runLoopbackPkce`, `auth.startLoopbackPkce`)
 * default to it when their `openUrl` test seam is not provided, so a
 * forgotten stub would spawn real browser tabs on the developer's
 * workstation. The runtime guard inside `browser.ts` short-circuits when
 * `NODE_ENV=test` or `BUN_TEST` is set; this test asserts that at least
 * one of those env vars fires under `bun test` so the guard is reliable.
 */
import { describe, expect, test } from "bun:test";
import { openUrlInDefaultBrowser, openUrlInDefaultBrowserChecked } from "../../src/browser";

describe("browser-safety-guard", () => {
  test("at least one of NODE_ENV=test / BUN_TEST is set under `bun test`", () => {
    const nodeEnv = process.env["NODE_ENV"];
    const bunTest = process.env["BUN_TEST"];
    const guardWillFire =
      nodeEnv === "test" || bunTest === "1" || bunTest === "true";
    expect(guardWillFire).toBe(true);
  });

  test("openUrlInDefaultBrowser returns synchronously without throwing", () => {
    expect(() =>
      openUrlInDefaultBrowser("https://test.invalid/should-not-open"),
    ).not.toThrow();
  });

  test("checked browser launch fails observably without spawning during tests", async () => {
    let failure: unknown;
    try {
      await openUrlInDefaultBrowserChecked("https://test.invalid/should-not-open");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("browser launch disabled during tests");
  });
});
