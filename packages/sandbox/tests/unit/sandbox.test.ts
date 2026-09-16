/**
 * Unit tests for the `Sandbox` class base shape. D060 Phase 1 task 1.4.
 *
 * The class is the orchestrator — every surface method is tested
 * here so 1.5's bwrap builder can assume the plumbing is sound.
 * `wrap()` is stubbed and asserted to throw; the real tests for the
 * returned SpawnArgs land in 1.5.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../../src/sandbox";
import { canonicalize } from "../../src/paths";
import type { SandboxBackend, SandboxConfig } from "../../src/types";

// On macOS, tmpdir() is /var/folders/... which realpath()s to
// /private/var/folders/.... Sandbox canonicalizes internally, so
// tests must too — otherwise isPathAllowed(tmp) fails because the
// argument and the internal workspace field don't match.
function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Construct a Sandbox with a pre-detected backend + ephemeral dirs.
 * Ephemeral dirs exist on the FS so canonicalize() resolves cleanly.
 */
function makeSandbox(overrides: {
  backend?: SandboxBackend;
  config?: Partial<SandboxConfig>;
  networkProxy?: ConstructorParameters<typeof Sandbox>[0]["networkProxy"];
  networkDeniedDestinations?: ConstructorParameters<typeof Sandbox>[0]["networkDeniedDestinations"];
} = {}): Sandbox {
  const tmp = mkTmp("nautilo-sandbox-test-");
  const config: SandboxConfig = {
    mode: "enabled",
    writablePaths: [],
    projectPaths: [],
    passthroughEnv: [],
    ...overrides.config,
  };
  return new Sandbox({
    config,
    workspace: join(tmp, "workspace"),
    dataDir: join(tmp, "data"),
    toolsBin: join(tmp, "tools-bin"),
    backend: overrides.backend ?? { kind: "bubblewrap", procSupported: true },
    networkProxy: overrides.networkProxy,
    networkDeniedDestinations: overrides.networkDeniedDestinations,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sandbox — config accessors", () => {
  test("getConfig returns the config passed to the constructor", () => {
    const sb = makeSandbox({ config: { passthroughEnv: ["MY_APP"] } });
    expect(sb.getConfig().passthroughEnv).toEqual(["MY_APP"]);
  });

  test("setConfig swaps the whole config atomically", () => {
    const sb = makeSandbox();
    sb.setConfig({
      mode: "disabled",
      writablePaths: ["/custom"],
      projectPaths: [],
      passthroughEnv: [],
    });
    expect(sb.getConfig().mode).toBe("disabled");
    expect(sb.getConfig().writablePaths).toEqual(["/custom"]);
  });

  test("PR-014 MAJOR #4 — setConfig resets dispatchLogged so next wrap() logs fresh dispatch", () => {
    // Scenario: boot with mode=disabled, call wrap() once (emits
    // `dispatch=passthrough (mode=disabled)` + sets dispatchLogged),
    // then operator flips to mode=enabled via setConfig(), calls
    // wrap() again. Without the fix, dispatchLogged=true suppresses
    // the new log line forever; operators grepping for `[sandbox] dispatch=`
    // in the logs see a single stale entry.
    //
    // We verify by mode-swap + re-inspecting the private field via
    // a test-only cast. Not elegant, but the alternative (mocking
    // @nautilo/logger across a module boundary) is substantially
    // heavier for a 1-line fix.
    const sb = makeSandbox({ config: { mode: "disabled" } });
    // Private-field view for the test — the fix is a 1-line state
    // transition on a private field; a direct reach-in is clearer
    // than mocking @nautilo/logger across the module boundary.
    // Narrow cast keeps eslint's no-explicit-any + no-unsafe-access
    // both happy without pragma noise.
    const privateView = sb as unknown as { dispatchLogged: boolean };
    // Trigger initial dispatch log by calling wrap() once.
    sb.wrap("/bin/echo", [], "/tmp", {});
    expect(privateView.dispatchLogged).toBe(true);
    // Rotate the config; the reset is the fix.
    sb.setConfig({
      mode: "enabled",
      writablePaths: [],
      projectPaths: [],
      passthroughEnv: [],
    });
    expect(privateView.dispatchLogged).toBe(false);
    // Next wrap() re-arms the flag AND (by virtue of being a fresh
    // call) emits the new log line reflecting the new mode.
    sb.wrap("/bin/echo", [], "/tmp", {});
    expect(privateView.dispatchLogged).toBe(true);
  });

  test("PR-014 MAJOR #4 — refreshProjectPaths does NOT reset dispatchLogged (log-spam avoidance)", () => {
    // Workspace switches happen frequently during normal use; each
    // one is NOT a dispatch change, just a mount-set change. Resetting
    // dispatchLogged here would flood logs with redundant dispatch
    // lines. Pin the boundary so a future "reset everywhere" refactor
    // can't silently regress into log spam.
    const sb = makeSandbox();
    const privateView = sb as unknown as { dispatchLogged: boolean };
    sb.wrap("/bin/echo", [], "/tmp", {});
    expect(privateView.dispatchLogged).toBe(true);
    sb.refreshProjectPaths(["/proj/a", "/proj/b"]);
    expect(privateView.dispatchLogged).toBe(true);
  });

  test("close disposes an owned network proxy", async () => {
    let closeCalls = 0;
    const sb = makeSandbox({
      backend: { kind: "sandbox-exec" },
      networkProxy: {
        url: "http://localhost:49152",
        port: 49152,
        close: () => {
          closeCalls += 1;
          return Promise.resolve();
        },
      },
    });

    await sb.close();
    expect(closeCalls).toBe(1);
  });

  test("consumeNetworkDeniedDestinations drains captured proxy denials", () => {
    const captured = [{
      host: "api.example.com",
      port: 443,
      reason: "no allow rule matched",
    }];
    const expected = [...captured];
    const sb = makeSandbox({
      backend: { kind: "sandbox-exec" },
      networkDeniedDestinations: captured,
    });

    expect(sb.consumeNetworkDeniedDestinations()).toEqual(expected);
    expect(sb.consumeNetworkDeniedDestinations()).toEqual([]);
  });

  test("refreshProjectPaths mutates only projectPaths, not writablePaths", () => {
    const sb = makeSandbox({ config: { writablePaths: ["/user/cfg"] } });
    sb.refreshProjectPaths(["/proj/a", "/proj/b"]);
    const cfg = sb.getConfig();
    expect(cfg.writablePaths).toEqual(["/user/cfg"]);
    expect(cfg.projectPaths).toEqual(["/proj/a", "/proj/b"]);
  });

  test("mode() reflects current config state", () => {
    const sb = makeSandbox({ config: { mode: "disabled" } });
    expect(sb.mode()).toBe("disabled");
    sb.setConfig({ ...sb.getConfig(), mode: "enabled" });
    expect(sb.mode()).toBe("enabled");
  });
});

describe("Sandbox — containmentActive", () => {
  test("true when mode=enabled + backend=bubblewrap", () => {
    const sb = makeSandbox({ backend: { kind: "bubblewrap", procSupported: true } });
    expect(sb.containmentActive()).toBe(true);
  });

  test("true when mode=enabled + backend=sandbox-exec", () => {
    const sb = makeSandbox({ backend: { kind: "sandbox-exec" } });
    expect(sb.containmentActive()).toBe(true);
  });

  test("false when mode=enabled + backend=none (WARN-worthy state)", () => {
    const sb = makeSandbox({ backend: { kind: "none" } });
    expect(sb.containmentActive()).toBe(false);
  });

  test("false when mode=disabled regardless of backend", () => {
    const sb = makeSandbox({
      config: { mode: "disabled" },
      backend: { kind: "bubblewrap", procSupported: true },
    });
    expect(sb.containmentActive()).toBe(false);
  });
});

describe("Sandbox — describeBackend", () => {
  test("bubblewrap includes procSupported bit", () => {
    expect(
      makeSandbox({ backend: { kind: "bubblewrap", procSupported: true } }).describeBackend(),
    ).toBe("bubblewrap(procSupported=true)");
    expect(
      makeSandbox({ backend: { kind: "bubblewrap", procSupported: false } }).describeBackend(),
    ).toBe("bubblewrap(procSupported=false)");
  });
  test("sandbox-exec / none are plain labels", () => {
    expect(makeSandbox({ backend: { kind: "sandbox-exec" } }).describeBackend()).toBe(
      "sandbox-exec",
    );
    expect(makeSandbox({ backend: { kind: "none" } }).describeBackend()).toBe("none");
  });
});

describe("Sandbox — isPathAllowed", () => {
  function makeWithWorkspace(ws: string, writablePaths: string[] = []): Sandbox {
    return new Sandbox({
      config: {
        mode: "enabled",
        writablePaths,
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: ws,
      dataDir: join(ws, "..", "data"),
      toolsBin: join(ws, "..", "tools"),
      backend: { kind: "bubblewrap", procSupported: true },
    });
  }

  test("true for workspace root", () => {
    const tmp = mkTmp("nautilo-ws-test-");
    expect(makeWithWorkspace(tmp).isPathAllowed(tmp)).toBe(true);
  });

  test("true for path under workspace", () => {
    const tmp = mkTmp("nautilo-ws-test-");
    const sb = makeWithWorkspace(tmp);
    expect(sb.isPathAllowed(join(tmp, "notes.md"))).toBe(true);
    expect(sb.isPathAllowed(join(tmp, "sub", "deep.md"))).toBe(true);
  });

  test("false for path outside workspace + writable paths", () => {
    const tmp = mkTmp("nautilo-ws-test-");
    const sb = makeWithWorkspace(tmp);
    expect(sb.isPathAllowed("/etc/passwd")).toBe(false);
    // Sibling-directory attack (H-012): "tmp + 'suffix'" must NOT be
    // allowed just because it starts with workspace's string form.
    expect(sb.isPathAllowed(tmp + "-suffix-attack")).toBe(false);
  });

  test("true for path under configured writable path (H-012 token boundary)", () => {
    const tmp1 = mkTmp("nautilo-ws-test-");
    const tmp2 = mkTmp("nautilo-extra-");
    const sb = makeWithWorkspace(tmp1, [tmp2]);
    expect(sb.isPathAllowed(join(tmp2, "file.md"))).toBe(true);
    expect(sb.isPathAllowed(tmp2 + "-sibling")).toBe(false);
  });
});

describe("Sandbox — prompt allowlists", () => {
  test("empty when containment inactive", () => {
    const sb = makeSandbox({ backend: { kind: "none" } });
    expect(sb.promptReadAllowlist()).toEqual([]);
    expect(sb.promptWriteAllowlist()).toEqual([]);
  });

  test("bubblewrap backend — read list includes Linux system paths (if they exist on host) + workspace + tools-bin", () => {
    const sb = makeSandbox({ backend: { kind: "bubblewrap", procSupported: true } });
    const reads = sb.promptReadAllowlist();
    // Only paths that actually exist on the test host are included;
    // assert a reasonable subset rather than the full list so the
    // test runs on any Linux/macOS dev machine.
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.some((p) => p === "/usr" || p === "/private/usr" || p === "/bin")).toBe(
      true,
    );
  });

  test("write list includes workspace + /tmp", () => {
    const sb = makeSandbox({ backend: { kind: "bubblewrap", procSupported: true } });
    const writes = sb.promptWriteAllowlist();
    expect(writes.length).toBeGreaterThanOrEqual(2);
    // /tmp always present
    expect(
      writes.some((p) => p === "/tmp" || p === "/private/tmp" || p.endsWith("/tmp")),
    ).toBe(true);
  });

  test("refreshProjectPaths extends the prompt allowlist", () => {
    const sb = makeSandbox({ backend: { kind: "bubblewrap", procSupported: true } });
    const before = sb.promptWriteAllowlist().length;
    const proj = mkTmp("nautilo-proj-");
    sb.refreshProjectPaths([proj]);
    const after = sb.promptWriteAllowlist().length;
    expect(after).toBe(before + 1);
    expect(sb.promptWriteAllowlist()).toContain(proj);
  });
});

describe("Sandbox.create — fail-loud policy (D060 Phase 1 task 1.7)", () => {
  test("failIfNoBackend=true + backend=none → THROWS with install instructions", async () => {
    const tmp = mkTmp("nautilo-fail-test-");
    const p = Sandbox.create({
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin: `${tmp}/tools`,
      failIfNoBackend: true,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    });
    expect(p).rejects.toThrow(
      /paranoid.*bubblewrap|Install bubblewrap|manage_server_security/,
    );
  });

  test("failIfNoBackend=false + backend=none → succeeds (WARN path)", async () => {
    const tmp = mkTmp("nautilo-warn-test-");
    const sb = await Sandbox.create({
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin: `${tmp}/tools`,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    });
    expect(sb.describeBackend()).toBe("none");
    expect(sb.containmentActive()).toBe(false);
  });

  test("networkPolicy=isolated + backend=none → THROWS even when failIfNoBackend=false", async () => {
    const tmp = mkTmp("nautilo-net-required-test-");
    const p = Sandbox.create({
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
        networkPolicy: { mode: "isolated" },
      },
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin: `${tmp}/tools`,
      failIfNoBackend: false,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    });
    expect(p).rejects.toThrow(/non-host network policy|sandbox backend/);
  });

  test("networkPolicy=proxy-allowlist + backend=none → THROWS instead of passthrough", async () => {
    const tmp = mkTmp("nautilo-proxy-required-test-");
    const p = Sandbox.create({
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
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin: `${tmp}/tools`,
      failIfNoBackend: false,
      detectBackendOverride: () => Promise.resolve({ kind: "none" }),
    });
    expect(p).rejects.toThrow(/non-host network policy|sandbox backend/);
  });

  test("failIfNoBackend=true + backend=bubblewrap → succeeds (no throw)", async () => {
    const tmp = mkTmp("nautilo-ok-test-");
    const sb = await Sandbox.create({
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin: `${tmp}/tools`,
      failIfNoBackend: true,
      detectBackendOverride: () => Promise.resolve({ kind: "bubblewrap", procSupported: true }),
    });
    expect(sb.containmentActive()).toBe(true);
  });

  test("failIfNoBackend=true + backend=sandbox-exec → succeeds (macOS paranoid)", async () => {
    const tmp = mkTmp("nautilo-ok-mac-test-");
    const sb = await Sandbox.create({
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        passthroughEnv: [],
      },
      workspace: tmp,
      dataDir: `${tmp}/data`,
      toolsBin: `${tmp}/tools`,
      failIfNoBackend: true,
      detectBackendOverride: () => Promise.resolve({ kind: "sandbox-exec" }),
    });
    expect(sb.containmentActive()).toBe(true);
  });
});

describe("Sandbox — wrap dispatcher", () => {
  test("mode=disabled → passthrough (env set, program echoes)", () => {
    const sb = makeSandbox({
      config: { mode: "disabled" },
      backend: { kind: "bubblewrap", procSupported: true },
    });
    const r = sb.wrap("ls", ["-la"], "/tmp", {});
    // Passthrough returns the original program, not "bwrap".
    expect(r.program).toBe("ls");
    expect(r.args).toEqual(["-la"]);
    expect(r.env).not.toBeNull();
    expect((r.env as Record<string, string>)["CI"]).toBe("true");
  });

  test("backend=none → passthrough (even with mode=enabled)", () => {
    const sb = makeSandbox({ backend: { kind: "none" } });
    const r = sb.wrap("ls", [], "/tmp", {});
    expect(r.program).toBe("ls");
    expect(r.env).not.toBeNull();
  });

  test("backend=bubblewrap → bwrap builder (program=bwrap, minimal env)", () => {
    const sb = makeSandbox({ backend: { kind: "bubblewrap", procSupported: true } });
    const r = sb.wrap("ls", ["/"], "/tmp", {});
    expect(r.program).toBe("bwrap");
    expect(Object.keys(r.env ?? {})).toEqual(["PATH"]);
    // Inner program appears after the `--` sentinel.
    const idx = r.args.lastIndexOf("--");
    expect(idx).toBeGreaterThan(0);
    expect(r.args.slice(idx)).toEqual(["--", "ls", "/"]);
  });

  test("backend=sandbox-exec → Phase 2 real buildSandboxExec path", () => {
    // Phase 2 replaced the stub with a real SBPL profile generator +
    // env-map builder. The wrap() call now returns SpawnArgs shaped
    // for sandbox-exec rather than throwing.
    const sb = makeSandbox({ backend: { kind: "sandbox-exec" } });
    const r = sb.wrap("ls", ["-la"], "/tmp", {});
    expect(r.program).toBe("/usr/bin/sandbox-exec");
    expect(r.args[0]).toBe("-p");
    // args[1] is the SBPL profile text — should start with the base
    // profile's header.
    expect(r.args[1]).toMatch(/^\(version 1\)/);
    expect(r.args[1]).toContain("(deny default)");
    // Original program + args come after the profile.
    expect(r.args.slice(2)).toEqual(["ls", "-la"]);
    // Env map is explicit (not null) — sandbox-exec has no --setenv.
    expect(r.env).not.toBeNull();
    expect(r.env?.["PATH"]).toBeDefined();
    expect(r.env?.["HOME"]).toBeDefined();
    expect(r.cwd).toBe("/tmp");
  });

  test("sandbox-exec networkPolicy=isolated denies network in profile", () => {
    const sb = makeSandbox({
      backend: { kind: "sandbox-exec" },
      config: { networkPolicy: { mode: "isolated" } },
    });
    const r = sb.wrap("ls", [], "/tmp", {});
    expect(r.args[1]).not.toContain("(allow network-outbound)");
    expect(r.env?.["HTTP_PROXY"]).toBeUndefined();
  });

  test("sandbox-exec proxy-allowlist injects owned proxy env", () => {
    const sb = makeSandbox({
      backend: { kind: "sandbox-exec" },
      config: {
        networkPolicy: {
          mode: "proxy-allowlist",
          allow: [{ type: "domain", host: "api.openai.com" }],
        },
      },
      networkProxy: {
        url: "http://localhost:49152",
        port: 49152,
        close: () => Promise.resolve(),
      },
    });
    const r = sb.wrap(
      "node",
      ["script.js"],
      "/tmp",
      { HTTPS_PROXY: "http://evil.example:8080" },
    );
    expect(r.args[1]).toContain('remote tcp "localhost:49152"');
    expect(r.args[1]).not.toContain("(allow network-bind)");
    expect(r.env?.["HTTP_PROXY"]).toBe("http://localhost:49152");
    expect(r.env?.["HTTPS_PROXY"]).toBe("http://localhost:49152");
  });

  test("bubblewrap dispatch honors procSupported=false (no --proc in args)", () => {
    const sb = makeSandbox({ backend: { kind: "bubblewrap", procSupported: false } });
    const r = sb.wrap("true", [], "/tmp", {});
    const procIdx = r.args.findIndex(
      (a, i) => a === "--proc" && r.args[i + 1] === "/proc",
    );
    expect(procIdx).toBe(-1);
  });

  test("DANGEROUS commandEnv dropped in both bwrap and passthrough paths", () => {
    const sbBwrap = makeSandbox({ backend: { kind: "bubblewrap", procSupported: true } });
    const bwrap = sbBwrap.wrap("true", [], "/tmp", { LD_PRELOAD: "/tmp/evil.so" });
    expect(bwrap.args.indexOf("LD_PRELOAD")).toBe(-1);

    const sbPassthrough = makeSandbox({ backend: { kind: "none" } });
    const passthrough = sbPassthrough.wrap("true", [], "/tmp", { LD_PRELOAD: "/tmp/evil.so" });
    expect((passthrough.env as Record<string, string>)["LD_PRELOAD"]).toBeUndefined();
  });
});
