import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
} from "../../src/ComposeDriver.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" };
}

const tmpDirs: string[] = [];
function mktmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeFakeExec(
  responder: (call: ExecCall) => ExecResult = () => ({ code: 0, stdout: "", stderr: "" }),
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: async (cmd, args, opts) => {
      const call = { cmd, args, opts };
      calls.push(call);
      return responder(call);
    },
  };
}

function makeDeps(over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("compose-driver-media-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template\n");
  const { exec } = makeFakeExec();
  return {
    exec,
    localExec: exec,
    fetch: (async () => new Response("ok")) as unknown as typeof fetch,
    runBootstrap: async () => undefined,
    fs: nodeFs,
    now: () => new Date("2026-05-19T12:34:56.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1,
    serverHealthTimeoutMs: 1,
    ensureDbPasswords: async () => ({
      appDbPassword: "x",
      postgresPassword: "x",
      nautilo: "x",
      logto: "x",
      nautiloAgent: "x",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ...over,
  };
}

const profile: ComposeDriverProfile = {
  name: "default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
  instance_id: "blue",
};

function isHomeProbe(call: ExecCall): boolean {
  return call.args.includes("exec") && call.args.some((arg) => arg.includes("echo $HOME"));
}

function isMediaProbe(call: ExecCall): boolean {
  return call.args.includes("exec") && call.args.some((arg) => arg.includes("profile-avatars server-icon"));
}

test("migrateMediaToVolume copies both legacy media roots and verifies the result", async () => {
  const local = makeFakeExec();
  const { exec, calls } = makeFakeExec((call) => {
    if (call.args[0] === "volume" && call.args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    if (isHomeProbe(call)) return { code: 0, stdout: "/home/nautilo\n", stderr: "" };
    if (isMediaProbe(call)) return { code: 0, stdout: "profile-avatars\nserver-icon\n", stderr: "" };
    if (call.args[0] === "volume" && call.args[1] === "create") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (call.args.includes("alpine") && call.args.some((arg) => arg === "ls -A /v")) {
      return { code: 0, stdout: "profile-avatars\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const driver = new ComposeDriver(makeDeps({ exec, localExec: local.exec }));

  await driver.migrateMediaToVolume(profile);

  expect(calls.some((call) => call.args.includes("nautilo-blue_app_media"))).toBe(true);
  const pipe = local.calls.find((call) => call.cmd === "sh")?.args[1] ?? "";
  expect(pipe).toContain("set -o pipefail");
  expect(pipe).toContain("-C /home/nautilo/.nautilo-blue");
  expect(pipe).toContain("profile-avatars server-icon");
  expect(pipe).toContain("-v nautilo-blue_app_media:/dst");
});

test("migrateMediaToVolume creates an empty volume when neither legacy directory exists", async () => {
  const logs: string[] = [];
  const local = makeFakeExec();
  const { exec, calls } = makeFakeExec((call) => {
    if (call.args[0] === "volume" && call.args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    if (isHomeProbe(call)) return { code: 0, stdout: "/root\n", stderr: "" };
    if (isMediaProbe(call)) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const driver = new ComposeDriver(makeDeps({ exec, localExec: local.exec, log: (line) => logs.push(line) }));

  await driver.migrateMediaToVolume(profile);

  expect(calls.some((call) => call.args[0] === "volume" && call.args[1] === "create")).toBe(true);
  expect(local.calls).toHaveLength(0);
  expect(logs.some((line) => line.includes("no avatar or server-icon media"))).toBe(true);
});

test("migrateMediaToVolume fails instead of reporting success when tar pipe fails", async () => {
  const { exec } = makeFakeExec((call) => {
    if (call.args[0] === "volume" && call.args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    if (isHomeProbe(call)) return { code: 0, stdout: "/root\n", stderr: "" };
    if (isMediaProbe(call)) return { code: 0, stdout: "server-icon\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const failedPipe: ExecFn = async () => ({ code: 2, stdout: "", stderr: "tar: short read" });
  const driver = new ComposeDriver(makeDeps({ exec, localExec: failedPipe }));

  // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
  await expect(driver.migrateMediaToVolume(profile)).rejects.toThrow(/copy from .* FAILED/);
});

test("migrateMediaToVolume uses the legacy remote DOCKER_HOST route", async () => {
  const remoteProfile = {
    ...profile,
    transport: "remote" as const,
    ssh: { host: "1.2.3.4", user: "root" },
  };
  const local = makeFakeExec();
  const { exec, calls } = makeFakeExec((call) => {
    if (call.args[0] === "volume" && call.args[1] === "inspect") {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    if (isHomeProbe(call)) return { code: 0, stdout: "/root\n", stderr: "" };
    if (isMediaProbe(call)) return { code: 0, stdout: "server-icon\n", stderr: "" };
    if (call.args.includes("alpine") && call.args.some((arg) => arg === "ls -A /v")) {
      return { code: 0, stdout: "server-icon\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const driver = new ComposeDriver(makeDeps({ exec, localExec: local.exec }));

  await driver.migrateMediaToVolume(remoteProfile);

  expect(calls.find((call) => call.args[0] === "volume" && call.args[1] === "create")?.opts.env?.["DOCKER_HOST"]).toBe(
    "ssh://root@1.2.3.4",
  );
  expect(local.calls.find((call) => call.cmd === "sh")?.opts.env?.["DOCKER_HOST"]).toBe(
    "ssh://root@1.2.3.4",
  );
});
