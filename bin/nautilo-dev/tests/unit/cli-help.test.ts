/**
 * Tests for the shared `cli-help` lib AND the `--help` short-circuit on the
 * three Phase 3 D153 commands.
 *
 * Load-bearing invariant: `--help` MUST NOT trigger any side effect — no
 * Bun.spawn, no fetch, no infraStart, no docker, no filesystem writes. The
 * `dev-stack` regression that motivated this work was `--help` falling
 * through to the orchestrator and actually invoking `infraStart()` against
 * smoke-stack19. Tests below pin that we exit 0 with text and no side
 * effects across all three commands.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { formatHelp, hasHelpFlag, type HelpSpec } from "../../src/lib/cli-help";
import {
  cleanupInstancesCmd,
  type CleanupInstancesDeps,
} from "../../src/commands/cleanup-instances";
import { devStackCmd } from "../../src/commands/dev-stack";
import { listInstancesCmd } from "../../src/commands/list-instances";
import { resolve } from "node:path";

describe("hasHelpFlag", () => {
  test("matches --help anywhere in args", () => {
    expect(hasHelpFlag(["--help"])).toBe(true);
    expect(hasHelpFlag(["foo", "--help"])).toBe(true);
    expect(hasHelpFlag(["--instance", "x", "--help"])).toBe(true);
  });
  test("matches -h anywhere in args", () => {
    expect(hasHelpFlag(["-h"])).toBe(true);
    expect(hasHelpFlag(["foo", "-h"])).toBe(true);
  });
  test("false when neither --help nor -h present", () => {
    expect(hasHelpFlag([])).toBe(false);
    expect(hasHelpFlag(["--electron"])).toBe(false);
    expect(hasHelpFlag(["--helpme"])).toBe(false); // load-bearing: substring must not false-positive
  });
});

describe("top-level command help floor", () => {
  test("infra-start --help exits without entering infrastructure startup", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "infra-start", "--help"],
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, DOCKER_HOST: "unix:///definitely-not-a-docker-socket" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("infra-start [flags]");
    expect(stdout).not.toContain("[infra:start] bringing up");
    expect(stderr).not.toContain("docker");
  });
});

describe("formatHelp shape", () => {
  const spec: HelpSpec = {
    name: "demo",
    summary: "demo command for tests",
    usage: "demo [--foo]",
    flags: [
      { flag: "--foo", description: "do the foo" },
      { flag: "--bar <n>", description: "set bar to n" },
    ],
    examples: [{ cmd: "demo --foo", desc: "do it" }, { cmd: "demo --bar 3" }],
    notes: ["see ISSUE-DEMO for context"],
  };
  const out = formatHelp(spec);

  test("contains name + summary + usage", () => {
    expect(out).toContain("demo — demo command for tests");
    expect(out).toContain("Usage: demo [--foo]");
  });
  test("contains every declared flag + description", () => {
    expect(out).toContain("--foo");
    expect(out).toContain("do the foo");
    expect(out).toContain("--bar <n>");
    expect(out).toContain("set bar to n");
  });
  test("contains every example, with optional desc when present", () => {
    expect(out).toContain("demo --foo");
    expect(out).toContain("do it");
    expect(out).toContain("demo --bar 3");
  });
  test("contains every note", () => {
    expect(out).toContain("see ISSUE-DEMO for context");
  });
});

describe("--help short-circuit: dev-stack", () => {
  let captured = "";
  const origLog = console.log;
  const origSpawn = globalThis.Bun?.spawn;
  const origFetch = globalThis.fetch;
  let spawnCalled = false;
  let fetchCalled = false;

  beforeEach(() => {
    captured = "";
    console.log = (...xs: unknown[]) => {
      captured += `${xs.join(" ")}\n`;
    };
    spawnCalled = false;
    fetchCalled = false;
    if (globalThis.Bun) {
      (globalThis.Bun as unknown as { spawn: unknown }).spawn = (() => {
        spawnCalled = true;
        throw new Error("Bun.spawn must not be called from --help");
      }) as unknown as typeof Bun.spawn;
    }
    globalThis.fetch = (() => {
      fetchCalled = true;
      throw new Error("fetch must not be called from --help");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    console.log = origLog;
    if (globalThis.Bun && origSpawn) {
      (globalThis.Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    }
    globalThis.fetch = origFetch;
  });

  test("--help exits 0 with help text; no spawn, no fetch", async () => {
    const code = await devStackCmd(["--help"]);
    expect(code).toBe(0);
    expect(captured).toContain("dev-stack — ");
    expect(captured).toContain("Usage:");
    expect(captured).toContain("--electron");
    expect(spawnCalled).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  test("-h short-form works identically", async () => {
    const code = await devStackCmd(["-h"]);
    expect(code).toBe(0);
    expect(captured).toContain("dev-stack — ");
    expect(spawnCalled).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  test("--help wins over --instance + --electron in same argv", async () => {
    const code = await devStackCmd(["--instance", "smoke-stack19", "--electron", "--help"]);
    expect(code).toBe(0);
    expect(captured).toContain("dev-stack — ");
    expect(spawnCalled).toBe(false);
    expect(fetchCalled).toBe(false);
  });
});

describe("--help short-circuit: cleanup-instances", () => {
  let captured = "";
  let exited: number | null = null;
  const origLog = console.log;

  beforeEach(() => {
    captured = "";
    exited = null;
    console.log = (...xs: unknown[]) => {
      captured += `${xs.join(" ")}\n`;
    };
  });
  afterEach(() => {
    console.log = origLog;
  });

  test("--help exits 0 with help text; no probe, no delete", async () => {
    const probeMany = mock(() => {
      throw new Error("probeMany must not be called from --help");
    });
    const listLocal = mock(() => {
      throw new Error("listLocal must not be called from --help");
    });
    const deleteInstanceFn = mock(() => {
      throw new Error("deleteInstance must not be called from --help");
    });
    const deps = {
      onExit: (c: number) => {
        exited = c;
      },
      probeMany,
      listLocal,
      deleteInstanceFn,
    } as unknown as CleanupInstancesDeps;
    await cleanupInstancesCmd(["--help"], deps);
    expect(exited).toBe(0);
    expect(captured).toContain("cleanup-instances — ");
    expect(captured).toContain("--stale");
    expect(probeMany).not.toHaveBeenCalled();
    expect(listLocal).not.toHaveBeenCalled();
    expect(deleteInstanceFn).not.toHaveBeenCalled();
  });
});

describe("--help short-circuit: list-instances", () => {
  let captured = "";
  const origLog = console.log;
  const origArgv = process.argv;

  beforeEach(() => {
    captured = "";
    console.log = (...xs: unknown[]) => {
      captured += `${xs.join(" ")}\n`;
    };
  });
  afterEach(() => {
    console.log = origLog;
    process.argv = origArgv;
  });

  test("--help prints help; completes synchronously without listing", async () => {
    process.argv = ["bun", "index.ts", "list-instances", "--help"];
    const t0 = performance.now();
    await listInstancesCmd();
    const elapsedMs = performance.now() - t0;
    expect(captured).toContain("list-instances — ");
    expect(captured).toContain("--json");
    // No-side-effect property: `formatHelp` is pure string concat, so this MUST complete in
    // single-digit ms. A real `listLocalInstances` filesystem walk + per-instance probe takes
    // ~200-400ms; if we ever regressed and the --help path fell through to the orchestrator,
    // this assertion would fail.
    expect(elapsedMs).toBeLessThan(50);
  });

  test("-h short-form works identically", async () => {
    process.argv = ["bun", "index.ts", "list-instances", "-h"];
    await listInstancesCmd();
    expect(captured).toContain("list-instances — ");
  });
});
