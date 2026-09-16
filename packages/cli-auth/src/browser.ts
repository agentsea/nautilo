/**
 * Best-effort browser launcher for CLI authentication flows.
 *
 * Decision §5.4 #8 explicitly rejected SSH detection — we always try and
 * let the OS report failure via the spawn `error` event (which we
 * swallow). On headless boxes the CLI falls back to device flow.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Test-suite safety: when running under `bun test` (Bun sets
 * `BUN_TEST=1` and exposes `Bun.jest` / `import.meta.test`), this is a
 * no-op. Any unit test that forgets to stub the `openUrl` test seam on
 * `useChangePassword` / `useForgotPassword` / `runLoopbackPkce` would
 * otherwise spawn real browser tabs on the developer's machine. Belt-and-
 * suspenders alongside the test-seam defaults.
 */
function isUnderBunTest(): boolean {
  // Bun sets BUN_TEST when running `bun test`. Vitest / jest set NODE_ENV=test.
  if (process.env["BUN_TEST"] === "1" || process.env["BUN_TEST"] === "true") {
    return true;
  }
  if (process.env["NODE_ENV"] === "test") return true;
  return false;
}

export function openUrlInDefaultBrowser(url: string): void {
  if (isUnderBunTest()) {
    // Hard guard: never spawn a browser from a test process. If a test
    // hits this path it means a seam was forgotten — silent no-op so the
    // test still runs to completion without polluting the developer's
    // workstation with rogue browser tabs.
    return;
  }
  try {
    const isWindows = platform() === "win32";
    const cmd =
      platform() === "darwin" ? "open" :
      isWindows               ? "start" :
                                "xdg-open";
    const args = isWindows ? ["", url] : [url];
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      shell: isWindows,
    });
    child.on("error", () => { /* no browser available — silent */ });
    child.unref();
  } catch {
    // best-effort; never throw from this path
  }
}

/**
 * Observable browser launch for security-sensitive native OAuth flows. Unlike
 * the legacy best-effort helper, this rejects when no browser process starts.
 */
export function openUrlInDefaultBrowserChecked(url: string): Promise<void> {
  if (isUnderBunTest()) {
    return Promise.reject(new Error("browser launch disabled during tests"));
  }
  return new Promise<void>((resolve, reject) => {
    try {
      const isWindows = platform() === "win32";
      const cmd = platform() === "darwin" ? "open" : isWindows ? "explorer.exe" : "xdg-open";
      const args = [url];
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.once("spawn", resolve);
      child.once("error", reject);
      child.unref();
    } catch (error) {
      reject(error instanceof Error ? error : new Error("browser launch failed"));
    }
  });
}
