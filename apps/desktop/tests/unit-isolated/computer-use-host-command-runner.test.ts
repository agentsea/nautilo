import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMacosComputerUseHostCommand } from "../../electron/computer-use-host-runtime/macos-attestor.ts";

test("attestation runner captures successful output and nonzero exits", async () => {
  expect(await runMacosComputerUseHostCommand(process.execPath, ["-e", 'process.stdout.write("ready"); process.stderr.write("diagnostic"); process.exitCode = 7;']))
    .toEqual({ code: 7, stdout: "ready", stderr: "diagnostic" });
  expect(await runMacosComputerUseHostCommand(process.execPath, ["-e", 'process.stdout.write("ready")']))
    .toEqual({ code: 0, stdout: "ready", stderr: "" });
});

test("attestation runner refuses a pre-cancelled launch and handles spawn failure", async () => {
  const controller = new AbortController(); controller.abort();
  expect(await runMacosComputerUseHostCommand("/nonexistent/probe", [], controller.signal))
    .toEqual({ code: null, stdout: "", stderr: "" });
  expect((await runMacosComputerUseHostCommand("/nonexistent/probe", [])).code).not.toBe(0);
});

test("cancellation kills a SIGTERM-resistant probe and waits for its exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-probe-cancel-"));
  const marker = join(root, "ready");
  const controller = new AbortController();
  let pid: number | undefined;
  const child = runMacosComputerUseHostCommand(process.execPath, ["-e", `
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    setInterval(() => {}, 1000);
  `], controller.signal);
  try {
    const readyDeadline = Date.now() + 2000;
    while (pid === undefined && Date.now() < readyDeadline) {
      const text = await readFile(marker, "utf8").catch(() => "");
      if (text) pid = Number(text);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid).toBeDefined();
    controller.abort();
    expect((await child).code).not.toBe(0);
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    controller.abort();
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } }
    await child;
    await rm(root, { recursive: true, force: true });
  }
});
