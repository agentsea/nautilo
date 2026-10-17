/**
 * Unit tests for spawnSandboxed(). D060 Phase 1 task 1.8.
 *
 * Tests exercise the wrap+spawn composition against REAL programs
 * (native runtime fixtures and POSIX process groups) via the passthrough path — that way we
 * cover the full pipeline (wrap → spawn → stream capture → timeout)
 * without depending on bwrap being installed on the test host.
 *
 * The bwrap-specific path is covered by the 1.5 arg-builder tests
 * (shape assertions) + the 1.9 integration tests (real bwrap inside
 * a Lima VM).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../../src/sandbox";
import { spawnSandboxed } from "../../src/spawn";
import { canonicalize } from "../../src/paths";

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Build a passthrough-mode sandbox so real subprocess spawns happen
 * without requiring bwrap. The env taxonomy still applies.
 */
function passthroughSandbox(): Sandbox {
  const tmp = mkTmp("nautilo-spawn-test-");
  return new Sandbox({
    config: {
      mode: "disabled",
      writablePaths: [],
      projectPaths: [],
      passthroughEnv: [],
    },
    workspace: tmp,
    dataDir: `${tmp}/data`,
    toolsBin: `${tmp}/tools`,
    backend: { kind: "none" },
  });
}

describe("spawnSandboxed — happy path (passthrough)", () => {
  test("a native child returns stdout + exitCode=0", async () => {
    const sb = passthroughSandbox();
    const r = await spawnSandboxed(sb, process.execPath, ["-e", "process.stdout.write('hello world\\n')"], {
      cwd: tmpdir(),
    });
    expect(r.stdout).toBe("hello world\n");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.signal).toBeNull();
  });

  test("stderr captured separately from stdout", async () => {
    const sb = passthroughSandbox();
    const r = await spawnSandboxed(
      sb,
      process.execPath,
      ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n')"],
      { cwd: tmpdir() },
    );
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect(r.exitCode).toBe(0);
  });

  test("non-zero exit code surfaces as exitCode (not thrown)", async () => {
    const sb = passthroughSandbox();
    const r = await spawnSandboxed(sb, process.execPath, ["-e", "process.exit(42)"], {
      cwd: tmpdir(),
    });
    expect(r.exitCode).toBe(42);
    expect(r.timedOut).toBe(false);
  });
});

describe("spawnSandboxed — timeout", () => {
  test("subprocess killed after timeoutMs; result.timedOut=true", async () => {
    const sb = passthroughSandbox();
    const start = Date.now();
    const r = await spawnSandboxed(sb, process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      cwd: tmpdir(),
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    // Should take ~100ms, not 5s. Allow generous margin for CI.
    expect(elapsed).toBeLessThan(2000);
    // The child was killed by SIGKILL; signal + exitCode semantics
    // differ across platforms. Just assert it didn't exit cleanly.
    expect(r.exitCode === null || r.signal !== null).toBe(true);
  });

  test.skipIf(process.platform === "win32")("timeout kills nested children that keep stdio pipes open", async () => {
    const sb = passthroughSandbox();
    const start = Date.now();
    // printf (not echo) so "partial" is flushed before sleep; kill delay must exceed
    // scheduler/pipe latency under parallel pre-push (500ms was racing empty stdout).
    const r = await spawnSandboxed(
      sb,
      "/bin/sh",
      ["-c", "printf 'partial\\n'; sleep 5; printf 'never-reached\\n'"],
      {
        cwd: "/tmp",
        timeoutMs: 1500,
      },
    );
    const elapsed = Date.now() - start;

    expect(r.timedOut).toBe(true);
    expect(r.stdout).toContain("partial");
    expect(r.stdout).not.toContain("never-reached");
    expect(elapsed).toBeLessThan(4000);
  });
});

describe("spawnSandboxed — shared cancellation and streaming stop", () => {
  test.skipIf(process.platform === "win32")("enclosing AbortSignal kills the process group without a private deadline", async () => {
    const sb = passthroughSandbox();
    const controller = new AbortController();
    const run = spawnSandboxed(sb, "/bin/sh", ["-c", "printf ready; sleep 5"], {
      cwd: "/tmp",
      timeoutMs: null,
      abortSignal: controller.signal,
      onStdoutChunk: () => {
        controller.abort();
      },
    });
    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stoppedEarly).toBe(false);
  });

  test("stdout observer can stop after a complete bounded result", async () => {
    const sb = passthroughSandbox();
    let observed = "";
    const result = await spawnSandboxed(
      sb,
      process.execPath,
      ["-e", "setInterval(() => process.stdout.write('one\\n'), 1)"],
      {
        cwd: tmpdir(),
        timeoutMs: null,
        onStdoutChunk: (chunk) => {
          observed += chunk.toString("utf8");
          return observed.includes("one") ? "stop" : undefined;
        },
      },
    );
    expect(observed).toContain("one");
    expect(result.stoppedEarly).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });
});

describe("spawnSandboxed — env taxonomy enforcement", () => {
  // The sandbox wraps env before spawn. These tests validate that the
  // wrapping actually reaches the child — proves the composition,
  // not just the individual layers.

  test("hardened defaults reach the child (CI=true, DEBIAN_FRONTEND=noninteractive)", async () => {
    const sb = passthroughSandbox();
    const r = await spawnSandboxed(
      sb,
      process.execPath,
      ["-e", "console.log('CI=' + process.env.CI + ' DF=' + process.env.DEBIAN_FRONTEND)"],
      { cwd: tmpdir() },
    );
    expect(r.stdout).toBe("CI=true DF=noninteractive\n");
  });

  test("DANGEROUS commandEnv is NOT visible in child", async () => {
    const sb = passthroughSandbox();
    const r = await spawnSandboxed(
      sb,
      process.execPath,
      ["-e", "console.log('PRELOAD=' + (process.env.LD_PRELOAD ?? ''))"],
      { cwd: tmpdir(), env: { LD_PRELOAD: "/tmp/evil.so" } },
    );
    // The var was dropped by the sandbox — the child sees empty
    // string (unset var expands to nothing).
    expect(r.stdout).toBe("PRELOAD=\n");
  });

  test("benign commandEnv IS visible in child", async () => {
    const sb = passthroughSandbox();
    const r = await spawnSandboxed(
      sb,
      process.execPath,
      ["-e", "console.log('MY_VAR=' + process.env.MY_VAR)"],
      { cwd: tmpdir(), env: { MY_VAR: "expected" } },
    );
    expect(r.stdout).toBe("MY_VAR=expected\n");
  });
});

describe("spawnSandboxed — stream truncation (D275-D4: bounded head+tail, no disk spill)", () => {
  test("over-budget stdout keeps head+tail, flags truncation, stays within ~budget, no file written", async () => {
    const sb = passthroughSandbox();
    // 500 chars of output, inline budget 100 (50 head / 50 tail).
    const r = await spawnSandboxed(
      sb,
      process.execPath,
      ["-e", "process.stdout.write('ABCDEFGHIJ'.repeat(50))"],
      { cwd: tmpdir(), maxBytesPerStream: 100 },
    );

    expect(r.stdoutTruncated).toBe(true);
    // Inline keeps both ends + a re-run hint (no path, no spill).
    expect(r.stdout).toContain("chars truncated");
    expect(r.stdout).toContain("re-run");
    expect(r.stdout.startsWith("ABCDEFGHIJ")).toBe(true); // head
    expect(r.stdout.trimEnd().endsWith("ABCDEFGHIJ")).toBe(true); // tail
    // Retained inline is bounded to ~budget (head + tail + short marker), NOT
    // the full 500 chars — proves memory is bounded, nothing accumulated.
    expect(r.stdout.length).toBeLessThan(300);
    expect(r.stdout.length).toBeGreaterThan(100); // head+tail+marker present
    // No `*FullPath` field exists on the result anymore.
    expect("stdoutFullPath" in r).toBe(false);
  });

  test("under-budget output returns full inline, no truncation", async () => {
    const sb = passthroughSandbox();
    const r = await spawnSandboxed(sb, process.execPath, ["-e", "process.stdout.write('hello')"], {
      cwd: tmpdir(),
      maxBytesPerStream: 1024,
    });
    expect(r.stdout).toBe("hello");
    expect(r.stdoutTruncated).toBe(false);
  });
});

describe("spawnSandboxed — error paths", () => {
  test("non-existent program → spawn error rejects the promise", async () => {
    const sb = passthroughSandbox();
    const failure = await spawnSandboxed(sb, "/definitely/does/not/exist/binary", [], {
      cwd: tmpdir(),
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
  });
});

// PR-015 MINOR #5 — this test asserts the shape of `sb.wrap(...)`'s
// return value for the sandbox-exec backend; it does NOT exercise
// `spawnSandboxed` itself (the resulting `/usr/bin/sandbox-exec`
// call only runs on Darwin — unit tests on any host still need
// deterministic coverage of the dispatch shape). Previously lived
// inside the `spawnSandboxed — error paths` describe block, which
// was a naming drift — the test neither tests a spawn nor exercises
// an error path. Moved into its own describe block so a cold reader
// doesn't chase a false trail.
describe("Sandbox.wrap() — sandbox-exec dispatch shape (cross-platform unit-level)", () => {
  test("backend=sandbox-exec produces sandbox-exec SpawnArgs (spawn itself not exercised off-Darwin)", () => {
    // Phase 2 swapped the Phase-1 throw-stub for a real SBPL-profile
    // generator. `spawnSandboxed` can't actually EXECUTE the
    // resulting `/usr/bin/sandbox-exec` call on non-Darwin hosts,
    // so we instead assert the shape of what `sb.wrap()` produces —
    // the unit-level equivalent of "dispatch is correct." Actual
    // execution happens on a Tart VM via the D063 harness and the
    // live-Darwin regression tests in seatbelt-profile.test.ts.
    const tmp = mkTmp("nautilo-mac-test-");
    const sb = new Sandbox({
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin: `${tmp}/tools`,
      backend: { kind: "sandbox-exec" },
    });
    const wrapped = sb.wrap("/bin/true", [], "/tmp", {});
    expect(wrapped.program).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args[0]).toBe("-p");
    expect(wrapped.args[1]).toMatch(/^\(version 1\)/);
    expect(wrapped.args.slice(2)).toEqual(["/bin/true"]);
    expect(wrapped.env).not.toBeNull();
  });

  test.skipIf(process.platform === "win32")("prepends resolved python3 bin before toolsBin when toolsBin python3 is a symlink", () => {
    const tmp = mkTmp("nautilo-mac-python-path-test-");
    const toolsBin = join(tmp, "tools");
    const realBin = join(tmp, "Python.framework", "Versions", "3.11", "bin");
    mkdirSync(toolsBin, { recursive: true });
    mkdirSync(realBin, { recursive: true });
    writeFileSync(join(realBin, "python3.11"), "#!/bin/sh\n");
    symlinkSync("python3.11", join(realBin, "python3"));
    symlinkSync(join(realBin, "python3"), join(toolsBin, "python3"));

    const sb = new Sandbox({
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin,
      backend: { kind: "sandbox-exec" },
    });

    const wrapped = sb.wrap("/bin/true", [], "/tmp", {});
    const path = wrapped.env?.["PATH"];
    expect(path).toBeDefined();
    expect(path?.split(":").slice(0, 2)).toEqual([realBin, toolsBin]);
  });
});

// Clean up any leftover env leakage between tests.
beforeEach(() => {});
afterEach(() => {});
