/**
 * Unit tests for the bubblewrap arg builder. D060 Phase 1 task 1.5.
 *
 * These tests don't invoke bwrap — they assert on the ARG LIST shape
 * + order. Mount order is load-bearing (later mounts override earlier
 * in bwrap), so drift here silently weakens isolation.
 *
 * The integration tests for 1.9 (SANDBOX-LINUX-* matrix) verify the
 * built command actually does what it claims when run against a real
 * bwrap binary inside a Lima VM.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBubblewrap } from "../../src/bubblewrap";
import { canonicalize } from "../../src/paths";
import type { SandboxConfig } from "../../src/types";

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

/** Build a canonical input with sensible defaults, overridable per test. */
function baseOpts(overrides: Partial<Parameters<typeof buildBubblewrap>[0]> = {}) {
  const workspace = mkTmp("bwrap-ws-");
  return {
    workspace,
    dataDir: join(workspace, "..", "data"),
    toolsBin: join(workspace, "..", "tools"),
    procSupported: true,
    config: {
      mode: "enabled",
      writablePaths: [],
      projectPaths: [],
      passthroughEnv: [],
    } satisfies SandboxConfig,
    cwd: workspace,
    commandEnv: {},
    program: "ls",
    args: ["/"],
    ...overrides,
  };
}

describe("buildBubblewrap — output shape", () => {
  test("program is 'bwrap' and spawn env is minimal", () => {
    const r = buildBubblewrap(baseOpts());
    expect(r.program).toBe("bwrap");
    expect(Object.keys(r.env ?? {})).toEqual(["PATH"]);
    expect((r.env as Record<string, string>)["LD_PRELOAD"]).toBeUndefined();
  });

  test("cwd is passed through", () => {
    const opts = baseOpts();
    const r = buildBubblewrap(opts);
    expect(r.cwd).toBe(opts.cwd);
  });

  test("ends with `--` program args", () => {
    const opts = baseOpts({ program: "echo", args: ["hello", "world"] });
    const r = buildBubblewrap(opts);
    const idx = r.args.lastIndexOf("--");
    expect(idx).toBeGreaterThan(0);
    expect(r.args.slice(idx)).toEqual(["--", "echo", "hello", "world"]);
  });
});

describe("buildBubblewrap — mount order (load-bearing)", () => {
  test("system ro-binds come BEFORE --bind workspace (step 1 < step 5)", () => {
    const opts = baseOpts();
    const args = buildBubblewrap(opts).args;
    const firstRoBindIdx = args.indexOf("--ro-bind");
    const workspaceBindIdx = args.findIndex(
      (a, i) => a === "--bind" && args[i + 1] === opts.workspace,
    );
    expect(firstRoBindIdx).toBeGreaterThanOrEqual(0);
    expect(workspaceBindIdx).toBeGreaterThan(firstRoBindIdx);
  });

  test("--dev /dev comes BEFORE --tmpfs /tmp (step 2 < step 4)", () => {
    const args = buildBubblewrap(baseOpts()).args;
    const devIdx = args.findIndex((a, i) => a === "--dev" && args[i + 1] === "/dev");
    const tmpfsIdx = args.findIndex(
      (a, i) => a === "--tmpfs" && args[i + 1] === "/tmp",
    );
    expect(devIdx).toBeGreaterThanOrEqual(0);
    expect(tmpfsIdx).toBeGreaterThan(devIdx);
  });

  test("--bind workspace BEFORE --tmpfs dataDir (step 5 < step 7)", () => {
    const opts = baseOpts();
    const args = buildBubblewrap(opts).args;
    const workspaceBindIdx = args.findIndex(
      (a, i) => a === "--bind" && args[i + 1] === opts.workspace,
    );
    const dataDirTmpfsIdx = args.findIndex(
      (a, i) => a === "--tmpfs" && args[i + 1] === opts.dataDir,
    );
    expect(workspaceBindIdx).toBeGreaterThanOrEqual(0);
    expect(dataDirTmpfsIdx).toBeGreaterThan(workspaceBindIdx);
  });

  test("isolation flags (step 8) come BEFORE --clearenv (step 9)", () => {
    const args = buildBubblewrap(baseOpts()).args;
    const unsharePid = args.indexOf("--unshare-pid");
    const clearenv = args.indexOf("--clearenv");
    expect(unsharePid).toBeGreaterThan(0);
    expect(clearenv).toBeGreaterThan(unsharePid);
  });

  test("D103: networkPolicy=isolated emits --unshare-net before --clearenv", () => {
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          networkPolicy: { mode: "isolated" },
        },
      }),
    ).args;
    const unshareNet = args.indexOf("--unshare-net");
    const clearenv = args.indexOf("--clearenv");
    expect(unshareNet).toBeGreaterThan(0);
    expect(clearenv).toBeGreaterThan(unshareNet);
  });

  test("D103: proxy-allowlist fails closed with Linux network isolation", () => {
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          networkPolicy: {
            mode: "proxy-allowlist",
            allow: [{ type: "domain", host: "api.openai.com" }],
          },
        },
      }),
    ).args;
    const unshareNet = args.indexOf("--unshare-net");
    const clearenv = args.indexOf("--clearenv");
    expect(unshareNet).toBeGreaterThan(0);
    expect(clearenv).toBeGreaterThan(unshareNet);
  });

  test("--clearenv BEFORE any --setenv (step 9 < step 11+)", () => {
    const args = buildBubblewrap(baseOpts()).args;
    const clearenv = args.indexOf("--clearenv");
    const firstSetenv = args.indexOf("--setenv");
    expect(clearenv).toBeGreaterThan(0);
    expect(firstSetenv).toBeGreaterThan(clearenv);
  });
});

describe("buildBubblewrap — procSupported", () => {
  test("procSupported=true emits --proc /proc", () => {
    const args = buildBubblewrap(baseOpts({ procSupported: true })).args;
    const idx = args.findIndex((a, i) => a === "--proc" && args[i + 1] === "/proc");
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  test("procSupported=false omits --proc /proc", () => {
    const args = buildBubblewrap(baseOpts({ procSupported: false })).args;
    const idx = args.findIndex((a, i) => a === "--proc" && args[i + 1] === "/proc");
    expect(idx).toBe(-1);
  });
});

describe("buildBubblewrap — writable paths", () => {
  test("each writablePaths entry that exists adds a --bind", () => {
    const p = mkTmp("bwrap-writable-");
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [p],
          projectPaths: [],
          passthroughEnv: [],
        },
      }),
    ).args;
    const idx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === p);
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  test("non-existent writable path is silently skipped (not emitted)", () => {
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: ["/definitely/does/not/exist/for/bwrap/test"],
          projectPaths: [],
          passthroughEnv: [],
        },
      }),
    ).args;
    const idx = args.indexOf("/definitely/does/not/exist/for/bwrap/test");
    expect(idx).toBe(-1);
  });

  test("projectPaths merged alongside writablePaths", () => {
    const a = mkTmp("bwrap-user-");
    const b = mkTmp("bwrap-proj-");
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [a],
          projectPaths: [b],
          passthroughEnv: [],
        },
      }),
    ).args;
    expect(args).toContain(a);
    expect(args).toContain(b);
  });
});

describe("buildBubblewrap — readOnlyPaths (D060 Sprint 1 G5.1)", () => {
  test("each readOnlyPaths entry that exists adds a --ro-bind", () => {
    const p = mkTmp("bwrap-ro-");
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          readOnlyPaths: [p],
        },
      }),
    ).args;
    const idx = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === p);
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  test("readOnlyPaths emits --ro-bind NOT --bind (no write access)", () => {
    const p = mkTmp("bwrap-ro-read-");
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          readOnlyPaths: [p],
        },
      }),
    ).args;
    // The path appears as a ro-bind target, never as a --bind target.
    const roBindIdx = args.findIndex(
      (a, i) => a === "--ro-bind" && args[i + 1] === p,
    );
    const bindIdx = args.findIndex(
      (a, i) => a === "--bind" && args[i + 1] === p,
    );
    expect(roBindIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBe(-1);
  });

  test("non-existent readOnlyPaths entry is skipped (no --ro-bind)", () => {
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          readOnlyPaths: ["/definitely/does/not/exist/for/bwrap/ro-test"],
        },
      }),
    ).args;
    const idx = args.indexOf("/definitely/does/not/exist/for/bwrap/ro-test");
    expect(idx).toBe(-1);
  });

  test("readOnly emitted BEFORE writable — bwrap later-wins gives writable overlays their --bind", () => {
    const ro = mkTmp("bwrap-order-ro-");
    const wrt = mkTmp("bwrap-order-wrt-");
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [wrt],
          projectPaths: [],
          passthroughEnv: [],
          readOnlyPaths: [ro],
        },
      }),
    ).args;
    const roBindIdx = args.findIndex(
      (a, i) => a === "--ro-bind" && args[i + 1] === ro,
    );
    const bindIdx = args.findIndex(
      (a, i) => a === "--bind" && args[i + 1] === wrt,
    );
    expect(roBindIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBeGreaterThan(roBindIdx);
  });

  test("readOnlyPaths absent (undefined) does not break build", () => {
    // Regression lock: accidentally spreading undefined would throw.
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          // readOnlyPaths intentionally omitted
        },
      }),
    ).args;
    expect(args.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D418 task 3.2.1 — canonical protected-path deny-overrides (--tmpfs masks)
// ---------------------------------------------------------------------------

describe("buildBubblewrap — protectedPaths (D418 3.2.1)", () => {
  test("each protectedPaths entry adds a --tmpfs mask AFTER every bind", () => {
    // bwrap is later-mount-wins: the --tmpfs mask must come AFTER the
    // workspace --bind (step 5), readOnly --ro-bind (6a), writable
    // --bind (6b), and the dataDir --tmpfs (7) so it overrides any
    // granted root that overlaps the protected subtree.
    const protectedRoot = mkTmp("bwrap-pp-secret-");
    const opts = baseOpts({
      workspace: mkTmp("bwrap-pp-ws-"),
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          protectedPaths: [protectedRoot],
        },
      });
    const args = buildBubblewrap(opts).args;

    const protectedTmpfsIdx = args.findIndex(
      (a, i) => a === "--tmpfs" && args[i + 1] === protectedRoot,
    );
    expect(protectedTmpfsIdx).toBeGreaterThanOrEqual(0);

    // After workspace --bind.
    const workspaceBindIdx = args.findIndex(
      (a, i) => a === "--bind" && args[i + 1] === opts.workspace,
    );
    expect(protectedTmpfsIdx).toBeGreaterThan(workspaceBindIdx);

    // After dataDir --tmpfs (step 7).
    const dataDirTmpfsIdx = args.findIndex(
      (a, i) => a === "--tmpfs" && args[i + 1] === opts.dataDir,
    );
    expect(protectedTmpfsIdx).toBeGreaterThan(dataDirTmpfsIdx);
  });

  test("protected-path --tmpfs wins over an overlapping writable --bind", () => {
    // The protected path sits INSIDE a writable bind; the --tmpfs mask
    // must come after the --bind so bwrap later-mount-wins keeps it
    // denied (empty tmpfs over the protected subtree).
    const writable = mkTmp("bwrap-pp-overlap-wrt-");
    const protectedChild = join(writable, ".ssh");
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [writable],
          projectPaths: [],
          passthroughEnv: [],
          protectedPaths: [protectedChild],
        },
      }),
    ).args;

    const writableBindIdx = args.findIndex(
      (a, i) => a === "--bind" && args[i + 1] === writable,
    );
    const protectedTmpfsIdx = args.findIndex(
      (a, i) => a === "--tmpfs" && args[i + 1] === protectedChild,
    );
    expect(writableBindIdx).toBeGreaterThanOrEqual(0);
    expect(protectedTmpfsIdx).toBeGreaterThan(writableBindIdx);
  });

  test("protectedPaths are canonicalized at emit time", () => {
    // The builder canonicalizes each entry (parallel to readOnlyPaths /
    // writablePaths) so a raw /var/... form on macOS still masks the
    // /private/var/... realpath bind.
    const protectedRoot = mkTmp("bwrap-pp-canonical-");
    const canonical = canonicalize(protectedRoot);
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          protectedPaths: [protectedRoot],
        },
      }),
    ).args;
    expect(args).toContain(canonical);
  });

  test("fails closed for an existing protected file without the capability-tested mask", () => {
    const protectedFile = join(mkTmp("bwrap-pp-file-"), "secret");
    writeFileSync(protectedFile, "secret");
    expect(() =>
      buildBubblewrap(
        baseOpts({
          config: {
            mode: "enabled",
            writablePaths: [],
            projectPaths: [],
            passthroughEnv: [],
            protectedPaths: [protectedFile],
          },
        }),
      ),
    ).toThrow("protected-file mask capability is unavailable");
  });

  test("uses a trusted zero-byte --ro-bind mask for an existing protected file", () => {
    const dir = mkTmp("bwrap-pp-file-mask-");
    const protectedFile = join(dir, "secret");
    const mask = join(dir, "trusted-empty-mask");
    writeFileSync(protectedFile, "secret");
    writeFileSync(mask, "");
    const args = buildBubblewrap(
      baseOpts({
        fileMaskSupported: true,
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          protectedPaths: [protectedFile],
          protectedFileMaskPath: mask,
        },
      }),
    ).args;
    const maskBindIdx = args.findIndex(
      (arg, index) =>
        arg === "--ro-bind" &&
        args[index + 1] === mask &&
        args[index + 2] === protectedFile,
    );
    expect(maskBindIdx).toBeGreaterThanOrEqual(0);
  });

  test("protectedPaths are emitted before the isolation flags (step 7a < step 8)", () => {
    // Mounts must be fully set up before --unshare-pid / --clearenv.
    const protectedRoot = mkTmp("bwrap-pp-order-");
    const args = buildBubblewrap(
      baseOpts({
        config: {
          mode: "enabled",
          writablePaths: [],
          projectPaths: [],
          passthroughEnv: [],
          protectedPaths: [protectedRoot],
        },
      }),
    ).args;
    const protectedTmpfsIdx = args.findIndex(
      (a, i) => a === "--tmpfs" && args[i + 1] === protectedRoot,
    );
    const unsharePidIdx = args.indexOf("--unshare-pid");
    expect(protectedTmpfsIdx).toBeGreaterThanOrEqual(0);
    expect(unsharePidIdx).toBeGreaterThan(protectedTmpfsIdx);
  });

  test("absent protectedPaths does not break the build (no extra --tmpfs)", () => {
    const args = buildBubblewrap(baseOpts()).args;
    // Only the dataDir + /tmp tmpfs entries should be present; no
    // protected-path section is emitted when the field is absent.
    const tmpfsCount = args.filter((a) => a === "--tmpfs").length;
    expect(tmpfsCount).toBe(2); // /tmp + dataDir
  });
});

describe("buildBubblewrap — env plumbing", () => {
  test("hardened defaults are always emitted (PATH, HOME, TMPDIR, CI, DEBIAN_FRONTEND)", () => {
    const args = buildBubblewrap(baseOpts()).args;
    // PATH
    const pathIdx = args.findIndex(
      (a, i) => a === "--setenv" && args[i + 1] === "PATH",
    );
    expect(pathIdx).toBeGreaterThanOrEqual(0);
    // TMPDIR=/tmp
    const tmpIdx = args.findIndex(
      (a, i) => a === "--setenv" && args[i + 1] === "TMPDIR" && args[i + 2] === "/tmp",
    );
    expect(tmpIdx).toBeGreaterThanOrEqual(0);
    // CI=true
    const ciIdx = args.findIndex(
      (a, i) => a === "--setenv" && args[i + 1] === "CI" && args[i + 2] === "true",
    );
    expect(ciIdx).toBeGreaterThanOrEqual(0);
  });

  test("HOME is set to workspace path", () => {
    const opts = baseOpts();
    const args = buildBubblewrap(opts).args;
    const idx = args.findIndex(
      (a, i) => a === "--setenv" && args[i + 1] === "HOME" && args[i + 2] === opts.workspace,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  test("PATH prepends toolsBin ahead of parent PATH", () => {
    const opts = baseOpts();
    const args = buildBubblewrap(opts).args;
    const pathIdx = args.findIndex(
      (a, i) => a === "--setenv" && args[i + 1] === "PATH",
    );
    expect(pathIdx).toBeGreaterThanOrEqual(0);
    const pathValue = args[pathIdx + 2] as string;
    expect(pathValue.startsWith(opts.toolsBin)).toBe(true);
  });

  test("passthroughEnv: emitted when present in parent; reserved names skipped", () => {
    const prior = process.env["MY_SB_TEST_VAR"];
    process.env["MY_SB_TEST_VAR"] = "hello";
    try {
      const args = buildBubblewrap(
        baseOpts({
          config: {
            mode: "enabled",
            writablePaths: [],
            projectPaths: [],
            passthroughEnv: ["MY_SB_TEST_VAR", "PATH"], // PATH is reserved
          },
        }),
      ).args;
      const myVarIdx = args.findIndex(
        (a, i) => a === "--setenv" && args[i + 1] === "MY_SB_TEST_VAR" && args[i + 2] === "hello",
      );
      expect(myVarIdx).toBeGreaterThanOrEqual(0);
      // PATH only appears as the hardened default, not as a passthrough — count occurrences
      const pathOccurrences = args.filter(
        (a, i) => a === "--setenv" && args[i + 1] === "PATH",
      ).length;
      expect(pathOccurrences).toBe(1);
    } finally {
      if (prior === undefined) delete process.env["MY_SB_TEST_VAR"];
      else process.env["MY_SB_TEST_VAR"] = prior;
    }
  });

  test("commandEnv: emitted; reserved SKIPPED; dangerous DROPPED (no --setenv)", () => {
    const opts = baseOpts({
      commandEnv: {
        USER_VAR: "value",
        PATH: "should-not-override", // reserved
        LD_PRELOAD: "/tmp/evil.so", // dangerous
      },
    });
    const args = buildBubblewrap(opts).args;
    // USER_VAR present
    const userIdx = args.findIndex(
      (a, i) => a === "--setenv" && args[i + 1] === "USER_VAR",
    );
    expect(userIdx).toBeGreaterThanOrEqual(0);
    // PATH not set by commandEnv (only hardened default)
    const pathOccurrences = args.filter(
      (a, i) => a === "--setenv" && args[i + 1] === "PATH",
    ).length;
    expect(pathOccurrences).toBe(1);
    // LD_PRELOAD nowhere in args
    expect(args.indexOf("LD_PRELOAD")).toBe(-1);
  });
});

describe("buildBubblewrap — integration-ish", () => {
  test("snapshot of a canonical full args sequence (verifies step-by-step order)", () => {
    // Plant a real toolsBin dir so step 1a fires.
    const workspace = mkTmp("bwrap-snap-ws-");
    const toolsBin = mkTmp("bwrap-snap-tools-");
    const dataDir = join(workspace, "..", "data");
    writeFileSync(join(toolsBin, "placeholder"), "");
    const args = buildBubblewrap({
      workspace,
      dataDir,
      toolsBin,
      procSupported: true,
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      cwd: workspace,
      commandEnv: {},
      program: "true",
      args: [],
    }).args;
    // Verify the non-variable-content anchors appear in order.
    const markers = [
      "--ro-bind",       // step 1
      "--dev",           // step 2
      "--proc",          // step 3
      "--tmpfs",         // step 4 (/tmp) — may also be step 7 (dataDir)
      "--bind",          // step 5 (workspace)
      "--unshare-pid",   // step 8
      "--new-session",   // step 8
      "--die-with-parent", // step 8
      "--clearenv",      // step 9
      "--chdir",         // step 10
      "--setenv",        // step 11+
      "--",              // step 15 separator
      "true",            // program
    ];
    let lastIdx = -1;
    for (const m of markers) {
      const nextIdx = args.indexOf(m, lastIdx + 1);
      expect(nextIdx).toBeGreaterThan(lastIdx);
      lastIdx = nextIdx;
    }
  });
});
