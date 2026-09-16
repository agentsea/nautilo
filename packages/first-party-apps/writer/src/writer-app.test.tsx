import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(15_000);

const HARNESS_PATH = new URL("./writer-app-reconnect-harness.tsx", import.meta.url).pathname;

async function runReconnectHarness(): Promise<void> {
  const child = Bun.spawn([process.execPath, "test", HARNESS_PATH], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Writer reconnect harness failed (exit ${exitCode}):\n${stdout}${stderr}`);
  }
}

describe("WriterApp reconnect review state", () => {
  test("runs the browser-only WriterApp integration in an isolated module cache", runReconnectHarness);
});
