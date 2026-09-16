import { describe, expect, test } from "bun:test";
import { createNodeProcessHost, signalGroupAsync } from "../../src/process-host";

describe("node process host group signals", () => {
  test("reports EPERM as a rejected Promise instead of escaping synchronously", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EPERM" });
    let escapedSynchronously = false;
    let result: Promise<void> | undefined;

    try {
      result = signalGroupAsync(123, "SIGTERM", () => true, () => { throw denied; });
    } catch {
      escapedSynchronously = true;
    }

    expect(escapedSynchronously).toBe(false);
    expect(result).toBeInstanceOf(Promise);
    let rejected: unknown;
    try { await result; } catch (error) { rejected = error; }
    expect(rejected).toBe(denied);
  });

  test("preserves ESRCH as an already-gone successful signal", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ESRCH" });
    let fallbackCalls = 0;

    await signalGroupAsync(123, "SIGKILL", () => { fallbackCalls += 1; return true; }, () => { throw missing; });
    expect(fallbackCalls).toBe(0);
  });

  test("contains an independently detached command group before reporting absence", async () => {
    if (process.platform === "win32") return;
    const host = createNodeProcessHost();
    const child = await host.spawn({
      executablePath: process.execPath,
      args: ["-e", [
        "const { spawn } = require('node:child_process');",
        "process.on('SIGTERM', () => {});",
        "const nested = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { detached: true, stdio: 'ignore' });",
        "process.stdout.write(String(nested.pid) + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join(" ")],
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? process.cwd() },
      detached: true,
    });
    const iterator = child.stdio.stdout[Symbol.asyncIterator]();
    const announced = await iterator.next();
    expect(announced.done).toBe(false);
    if (!(announced.value instanceof Uint8Array)) throw new Error("Nested process identity was not announced");
    const nestedPid = Number(new TextDecoder().decode(announced.value).trim());
    expect(Number.isSafeInteger(nestedPid)).toBe(true);

    await child.signalProcessGroup("SIGTERM");
    expect(await eventuallyAbsent(() => child.isProcessGroupGone())).toBe(true);
    expect(groupAbsent(nestedPid)).toBe(true);
  });
});

function groupAbsent(pid: number): boolean {
  try { process.kill(-pid, 0); return false; }
  catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}

async function eventuallyAbsent(probe: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await probe()) return true;
    await Bun.sleep(10);
  }
  return false;
}
