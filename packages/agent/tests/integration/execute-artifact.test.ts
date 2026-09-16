/**
 * Integration test for execute_artifact — D073 + D060 Sprint 2 G5.
 *
 * These tests actually spawn subprocesses via the real sandbox (no
 * mock Sandbox; no mock spawnSandboxed). They assert the end-to-end
 * wiring works: zone provider → runtime detection → Sandbox.create
 * → spawnSandboxed → output capture.
 *
 * Uses .sh scripts exclusively because sh is universally available.
 * Python/Node/Bun tests would be nice but aren\u0027t required to prove
 * the dispatch pipeline.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStorageZones,
  ensureDirectoryTree,
  resolveNautiloRuntimePaths,
  fromRuntimeConfig,
  setConfigOverrides,
} from "@nautilo/config";
import {
  createExecuteArtifactTool,
  setArtifactStorage,
  resetArtifactStorage,
} from "../../src/index";
import { Sandbox, type SandboxConfig } from "@nautilo/sandbox";

function makeRoot(): string {
  const path = join(
    tmpdir(),
    `execute-artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

let root: string;
let nautiloRoot: string;

beforeEach(async () => {
  root = makeRoot();
  const paths = resolveNautiloRuntimePaths({
    config: fromRuntimeConfig({}),
    env: {},
    userHomeDir: root,
  });
  nautiloRoot = paths.rootDir;
  await ensureDirectoryTree(paths);
  setArtifactStorage(createStorageZones(paths));
  // Force cautious posture so the sandbox uses passthrough-with-
  // hardened-env (runs on any host, no bwrap/sandbox-exec required
  // for the "command actually runs" assertion).
  setConfigOverrides({
    nautilo_deployment_mode: "desktop-permissive",
    nautilo_security_level: "cautious",
  });
});

afterEach(() => {
  resetArtifactStorage();
  setConfigOverrides({});
  rmSync(root, { recursive: true, force: true });
});

describe("execute_artifact — integration", () => {
  test("runs a .sh script + returns stdout", async () => {
    // Write a sh script to the home zone.
    const scriptPath = join(nautiloRoot, "home", "hello.sh");
    mkdirSync(join(nautiloRoot, "home"), { recursive: true });
    writeFileSync(scriptPath, "#!/bin/sh\necho 'hello from sandbox'\n", "utf-8");
    chmodSync(scriptPath, 0o755);

    const tool = createExecuteArtifactTool();
    const result = (await tool.invoke({
      path: "hello.sh",
      zone: "home",
    }));

    expect(result).toContain("hello from sandbox");
    expect(result).toContain("--- exit 0 (ok) ---");
  });

  test("does not add a second output crop above the configured sandbox budget", async () => {
    const sentinel = "COMPLETE-ARTIFACT-OUTPUT-SENTINEL";
    const longOutput = `${"x".repeat(100_000)}${sentinel}`;
    const home = join(nautiloRoot, "home");
    const scriptPath = join(home, "long-output.sh");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "long-output.txt"), longOutput, "utf-8");
    writeFileSync(scriptPath, "#!/bin/sh\ncat long-output.txt\n", "utf-8");
    chmodSync(scriptPath, 0o755);

    const priorBudget = process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"];
    process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"] = String(
      Buffer.byteLength(longOutput, "utf8") + 1024,
    );
    try {
      const tool = createExecuteArtifactTool();
      const result = await tool.invoke({ path: "long-output.sh", zone: "home" });

      // The configurable sandbox budget keeps this full stream inline. This
      // used to be silently cropped again by execute_artifact at 100,000 chars.
      expect(result).toContain(sentinel);
    } finally {
      if (priorBudget === undefined) {
        delete process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"];
      } else {
        process.env["NAUTILO_SANDBOX_INLINE_OUTPUT_BYTES"] = priorBudget;
      }
    }
  });

  test("threads server network policy into sandbox config and closes sandbox", async () => {
    setConfigOverrides({
      nautilo_deployment_mode: "desktop-permissive",
      nautilo_security_level: "cautious",
      nautilo_network_policy: { mode: "isolated" },
    });

    const scriptPath = join(nautiloRoot, "home", "network-policy.sh");
    mkdirSync(join(nautiloRoot, "home"), { recursive: true });
    writeFileSync(scriptPath, "#!/bin/sh\necho 'network policy threaded'\n", "utf-8");
    chmodSync(scriptPath, 0o755);

    const originalCreate = Sandbox.create;
    const originalClose = Sandbox.prototype.close;
    let capturedNetworkPolicy: SandboxConfig["networkPolicy"] | undefined;
    let closeCalls = 0;
    Sandbox.create = (async (opts: Parameters<typeof Sandbox.create>[0]) => {
      const { detectBackendOverride: _detectBackendOverride, ...constructorOpts } = opts;
      capturedNetworkPolicy = constructorOpts.config.networkPolicy;
      return new Sandbox({
        ...constructorOpts,
        backend: { kind: "none" },
      });
    }) as typeof Sandbox.create;
    Sandbox.prototype.close = async function () {
      closeCalls += 1;
      await originalClose.call(this);
    };

    try {
      const tool = createExecuteArtifactTool();
      const result = (await tool.invoke({
        path: "network-policy.sh",
        zone: "home",
      }));

      expect(result).toContain("network policy threaded");
      expect(capturedNetworkPolicy).toEqual({ mode: "isolated" });
      expect(closeCalls).toBe(1);
    } finally {
      Sandbox.create = originalCreate;
      Sandbox.prototype.close = originalClose;
    }
  });

  test("rejects unsupported extension with explicit allowlist message", async () => {
    const scriptPath = join(nautiloRoot, "home", "tool.exe");
    mkdirSync(join(nautiloRoot, "home"), { recursive: true });
    writeFileSync(scriptPath, "binary-ish content", "utf-8");

    const tool = createExecuteArtifactTool();
    const result = (await tool.invoke({
      path: "tool.exe",
      zone: "home",
    }));

    expect(result).toContain("Error: extension not in the runtime allowlist");
    expect(result).toContain(".py"); // listing must include something
  });

  test("rejects non-existent file", async () => {
    const tool = createExecuteArtifactTool();
    const result = (await tool.invoke({
      path: "does-not-exist.sh",
      zone: "home",
    }));
    expect(result).toContain("Error: artifact not found");
  });

  test("rejects directories", async () => {
    mkdirSync(join(nautiloRoot, "home", "not-a-script.sh"), { recursive: true });
    const tool = createExecuteArtifactTool();
    const result = (await tool.invoke({
      path: "not-a-script.sh",
      zone: "home",
    }));
    expect(result).toContain("is a directory");
  });

  test("script non-zero exit surfaces exit code but NOT as 'Error:'", async () => {
    // Non-zero exit is a script telling you something failed. The
    // model needs to see stdout/stderr to understand why — don\u0027t
    // wrap it as an "Error:" string or the result scanner may mask
    // useful content. The exit code goes in the footer instead.
    const scriptPath = join(nautiloRoot, "home", "fail.sh");
    mkdirSync(join(nautiloRoot, "home"), { recursive: true });
    writeFileSync(
      scriptPath,
      "#!/bin/sh\necho 'about to exit non-zero'\nexit 42\n",
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);

    const tool = createExecuteArtifactTool();
    const result = (await tool.invoke({
      path: "fail.sh",
      zone: "home",
    }));

    expect(result).not.toMatch(/^Error:/);
    expect(result).toContain("about to exit non-zero");
    expect(result).toContain("--- exit 42 (non-zero) ---");
  });

  test("stdin forwarding: script reads stdin + echoes", async () => {
    // D073 stdin param end-to-end via spawnSandboxed\u0027s new stdin support.
    const scriptPath = join(nautiloRoot, "home", "echo-stdin.sh");
    mkdirSync(join(nautiloRoot, "home"), { recursive: true });
    writeFileSync(
      scriptPath,
      "#!/bin/sh\ncat\n", // `cat` with no args reads stdin + writes stdout
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);

    const tool = createExecuteArtifactTool();
    const result = (await tool.invoke({
      path: "echo-stdin.sh",
      zone: "home",
      stdin: "piped-input-value",
    }));

    expect(result).toContain("piped-input-value");
  });

  test(
    "timeout kills long-running script + surfaces partial output",
    async () => {
      // spawnSandboxed starts a process group and kills the group on
      // timeout, so nested children cannot keep stdio pipes open until
      // their natural sleep finishes.
      const scriptPath = join(nautiloRoot, "home", "slow.sh");
      mkdirSync(join(nautiloRoot, "home"), { recursive: true });
      writeFileSync(
        scriptPath,
        "#!/bin/sh\necho 'partial'\nsleep 2\necho 'never reached'\n",
        "utf-8",
      );
      chmodSync(scriptPath, 0o755);

      const tool = createExecuteArtifactTool();
      const result = (await tool.invoke({
        path: "slow.sh",
        zone: "home",
        timeoutMs: 300,
      }));

      expect(result).toContain("timed out");
      expect(result).not.toContain("never reached");
    },
    10_000, // bun test timeout override
  );

  test("scratch zone works the same as home", async () => {
    const scriptPath = join(nautiloRoot, "scratch", "s.sh");
    mkdirSync(join(nautiloRoot, "scratch"), { recursive: true });
    writeFileSync(scriptPath, "#!/bin/sh\necho 'from scratch'\n", "utf-8");
    chmodSync(scriptPath, 0o755);

    const tool = createExecuteArtifactTool();
    const result = (await tool.invoke({
      path: "s.sh",
      zone: "scratch",
    }));

    expect(result).toContain("from scratch");
  });

  test("SEC-1: leading-dash filename treated as FILENAME, not flag (argv-injection defense)", async () => {
    // Plant a script whose filename starts with `-`. Without the
    // `./` safe-path prefix, `/bin/sh -c.sh <args>` would interpret
    // `-c` as the run-this-command option and `<args>` as executable
    // code. With the prefix, `./-c.sh` is treated as a filename.
    const scriptPath = join(nautiloRoot, "home", "-c.sh");
    mkdirSync(join(nautiloRoot, "home"), { recursive: true });
    writeFileSync(
      scriptPath,
      "#!/bin/sh\necho 'ran as filename not flag'\n",
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);

    const tool = createExecuteArtifactTool();
    const result = await tool.invoke({
      path: "-c.sh",
      zone: "home",
      // If the bug existed, these args would execute as a shell
      // command: `echo INJECTED`. We assert they do NOT appear in
      // output — the script\u0027s own echo wins.
      args: ["echo", "INJECTED"],
    });

    expect(result).toContain("ran as filename not flag");
    expect(result).not.toContain("INJECTED");
  });

  // NOTE (TEST-GAP): an explicit "audit row appended to
  // artifact-executions.jsonl" assertion would require dep-injecting
  // the audit-log path into createExecuteArtifactTool. The happy-
  // path tests above implicitly prove the write pathway: any
  // exception on audit-write would propagate + fail the test.
  // Tracked as a follow-up for the full ship-plan §5.8 query API
  // work (G5.8) which will refactor audit-log ingestion.

  test("schema rejects zone = 'data' (no access to app internals)", async () => {
    const tool = createExecuteArtifactTool();
    // Zod schema rejects invalid enum values at invoke time.
    let thrown: unknown = null;
    try {
      await tool.invoke({
        path: "whatever.sh",
        zone: "data" as unknown as "home",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
  });
});
