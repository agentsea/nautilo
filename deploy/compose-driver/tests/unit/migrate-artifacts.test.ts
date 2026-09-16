import { rejects } from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" };
}

function makeFakeExec(
  responder: (call: ExecCall) => ExecResult = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  }),
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    const call: ExecCall = { cmd, args, opts };
    calls.push(call);
    return responder(call);
  };
  return { exec, calls };
}

const baseProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

const tmpDirs: string[] = [];
function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cleanupTmp() {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
}

function makeDeps(over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("compose-driver-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    join(templateDir, "docker-compose.yml"),
    "# unit-test template marker\n",
  );
  const { exec } = makeFakeExec();
  const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    fs: nodeFs,
    now: () => new Date("2026-05-19T12:34:56.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ...over,
  };
}

function isHomeProbe(call: ExecCall): boolean {
  return (
    call.args.includes("exec") &&
    call.args.includes("-T") &&
    call.args.includes("nautilo-server") &&
    call.args.some((a) => a.includes("echo $HOME"))
  );
}

/** The source existence probe: `... exec -T nautilo-server sh -c 'if [ -d ... __NO_DIR__ ...'`. */
function isSourceProbe(call: ExecCall): boolean {
  return (
    call.args.includes("exec") &&
    call.args.includes("nautilo-server") &&
    call.args.some((a) => a.includes("__NO_DIR__"))
  );
}

/** The post-copy verification `run --rm -v <vol>:/v alpine sh -c 'ls -A /v'`. */
function isVerifyLs(call: ExecCall): boolean {
  return (
    call.args.includes("run") &&
    call.args.includes("alpine") &&
    call.args.some((a) => a === "ls -A /v")
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("migrateArtifactsToVolume", () => {
  let savedHome: string | undefined;
  let savedInstance: string | undefined;
  let hadInstanceKey = false;

  beforeEach(() => {
    savedHome = process.env["HOME"];
    savedInstance = process.env["NAUTILO_INSTANCE_ID"];
    hadInstanceKey = "NAUTILO_INSTANCE_ID" in process.env;
    process.env["HOME"] = mktmp("compose-driver-home-");
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env["HOME"] = savedHome;
    else delete process.env["HOME"];
    if (hadInstanceKey) {
      process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    } else {
      delete process.env["NAUTILO_INSTANCE_ID"];
    }
    cleanupTmp();
  });

  test("no-op when volume already exists and is non-empty", async () => {
    const logs: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args[0] === "volume" && call.args[1] === "inspect") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        call.args.includes("run") &&
        call.args.includes("alpine") &&
        call.args.some((a) => a.includes("ls -A"))
      ) {
        return { code: 0, stdout: "somefile\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        log: (msg) => logs.push(msg),
      }),
    );

    await driver.migrateArtifactsToVolume(baseProfile);

    expect(logs.some((l) => l.includes("already migrated"))).toBe(true);
    expect(calls.some((c) => c.args[0] === "volume" && c.args[1] === "create")).toBe(
      false,
    );
  });

  test("creates volume and runs tar pipe when not yet migrated", async () => {
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args[0] === "volume" && call.args[1] === "inspect") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (isHomeProbe(call)) {
        return { code: 0, stdout: "/home/nautilo\n", stderr: "" };
      }
      if (isSourceProbe(call)) {
        return { code: 0, stdout: "artifact1.png\n", stderr: "" };
      }
      if (isVerifyLs(call)) {
        return { code: 0, stdout: "artifact1.png\n", stderr: "" };
      }
      if (call.args[0] === "volume" && call.args[1] === "create") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec: fakeLocalExec,
      }),
    );

    await driver.migrateArtifactsToVolume(baseProfile);

    const createCall = calls.find(
      (c) => c.args[0] === "volume" && c.args[1] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall!.args[2]).toBe("nautilo_app_artifacts");

    const pipeCall = localExecCalls.find((c) => c.cmd === "sh" && c.args[0] === "-c");
    expect(pipeCall).toBeDefined();
    const pipe = pipeCall!.args[1] as string;
    expect(pipe).toContain("set -o pipefail");
    expect(pipe).toContain("tar czf - -C /home/nautilo/.nautilo/artifacts");
    expect(pipe).toContain("-v nautilo_app_artifacts:/dst");
    expect(pipe).toContain("tar xzf - -C /dst");
  });

  test("creates an EMPTY volume and skips the copy when no artifacts exist", async () => {
    const logs: string[] = [];
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args[0] === "volume" && call.args[1] === "inspect") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (isHomeProbe(call)) {
        return { code: 0, stdout: "/root\n", stderr: "" };
      }
      if (isSourceProbe(call)) {
        // The artifacts dir was never created (lazy on first save).
        return { code: 0, stdout: "__NO_DIR__\n", stderr: "" };
      }
      if (call.args[0] === "volume" && call.args[1] === "create") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({ exec, localExec: fakeLocalExec, log: (m) => logs.push(m) }),
    );

    await driver.migrateArtifactsToVolume(baseProfile);

    // Volume IS created so deploy can proceed, but no copy pipe runs.
    expect(calls.some((c) => c.args[0] === "volume" && c.args[1] === "create")).toBe(true);
    expect(localExecCalls.some((c) => c.cmd === "sh")).toBe(false);
    expect(logs.some((l) => l.includes("no artifacts found"))).toBe(true);
  });

  test("throws (never reports success) when the copy pipe fails", async () => {
    const logs: string[] = [];
    const fakeLocalExec: ExecFn = async () => ({
      code: 2,
      stdout: "",
      stderr: "tar: short read",
    });
    const { exec } = makeFakeExec((call) => {
      if (call.args[0] === "volume" && call.args[1] === "inspect") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (isHomeProbe(call)) {
        return { code: 0, stdout: "/root\n", stderr: "" };
      }
      if (isSourceProbe(call)) {
        return { code: 0, stdout: "artifact1.png\n", stderr: "" };
      }
      if (call.args[0] === "volume" && call.args[1] === "create") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({ exec, localExec: fakeLocalExec, log: (m) => logs.push(m) }),
    );

    /* eslint-disable @typescript-eslint/await-thenable -- bun `expect().rejects` */
    await expect(driver.migrateArtifactsToVolume(baseProfile)).rejects.toThrow(
      /copy from .* FAILED/,
    );
    /* eslint-enable @typescript-eslint/await-thenable */
    expect(logs.some((l) => l.includes("copied artifacts from"))).toBe(false);
  });

  test("throws a clear error when no nautilo-server is running", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args[0] === "volume" && call.args[1] === "inspect") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (isHomeProbe(call)) {
        return { code: 1, stdout: "", stderr: "no such service: not running" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));

    /* eslint-disable @typescript-eslint/await-thenable -- bun `expect().rejects` */
    await expect(driver.migrateArtifactsToVolume(baseProfile)).rejects.toThrow(
      /must run while the PRE-Phase-1 server/,
    );
    /* eslint-enable @typescript-eslint/await-thenable */

    expect(calls.some((c) => c.args[0] === "volume" && c.args[1] === "create")).toBe(
      false,
    );
  });

  test("remote profile threads DOCKER_HOST", async () => {
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args[0] === "volume" && call.args[1] === "inspect") {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      if (isHomeProbe(call)) {
        return { code: 0, stdout: "/root\n", stderr: "" };
      }
      if (isSourceProbe(call)) {
        return { code: 0, stdout: "artifact1.png\n", stderr: "" };
      }
      if (isVerifyLs(call)) {
        return { code: 0, stdout: "artifact1.png\n", stderr: "" };
      }
      if (call.args[0] === "volume" && call.args[1] === "create") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec: fakeLocalExec,
        resolveInstanceRootDir: () => "/opt/nautilo",
      }),
    );

    await driver.migrateArtifactsToVolume(remoteProfile);

    const createCall = calls.find(
      (c) => c.args[0] === "volume" && c.args[1] === "create",
    );
    expect(createCall?.opts.env?.["DOCKER_HOST"]).toBe("ssh://root@1.2.3.4");

    const pipeCall = localExecCalls.find((c) => c.cmd === "sh" && c.args[0] === "-c");
    expect(pipeCall?.opts.env?.["DOCKER_HOST"]).toBe("ssh://root@1.2.3.4");
  });
});

test("relocation admits exact labeled containers and sends private plan/probe data only on stdin", async () => {
  const server = "1".repeat(64); const database = "2".repeat(64);
  const snapshot = { identity: { id: "self", instance_id: "default", server_instance_id: "f0000000-0000-4000-8000-000000000000" },
    artifacts: [{ id: "a0000000-0000-4000-8000-000000000000", storage_uri: "file:///old/artifacts/file", size: 8, crypto_object_id: null }],
    message_attachments: [], workspace_document_mutation_entries: [] };
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const exec: ExecFn = async (_cmd, args, opts) => {
    calls.push({ args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    if (args[0] === "ps") return { code: 0, stdout: args.includes("label=com.docker.compose.service=nautilo-server") ? server : database, stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: "sha256:" + "3".repeat(64), stderr: "" };
    if (args.includes("psql")) return { code: 0, stdout: JSON.stringify(snapshot), stderr: "" };
    if (opts.stdin) return { code: 0, stdout: JSON.stringify([{ path: "/new/artifacts/file", size: 8, sha256: "a".repeat(64) }]), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ instanceId: "default", artifactsRoot: "/new/artifacts" }), stderr: "" };
  };
  const driver = new ComposeDriver(makeDeps({ exec }));
  await rejects(driver.relocateArtifacts(baseProfile, { sourceRoot: "/old/artifacts", backupPath: "/missing-original-backup" }), /verified v2 backup/);
  expect(calls.every(call => !call.args.join(" ").includes("file:///old/artifacts"))).toBe(true);
  const query = calls.find(call => call.args.includes("psql"));
  expect(query?.stdin).toContain("TRANSACTION READ ONLY"); expect(query?.args).toContain(database);
  expect(calls.find(call => call.stdin?.includes('"paths"'))?.args).toContain(server);
  expect(calls.some(call => call.args.some(arg => ["up", "stop", "restart", "rm", "run", "cp"].includes(arg)))).toBe(false);
});
