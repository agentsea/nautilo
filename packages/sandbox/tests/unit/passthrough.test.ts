/**
 * Unit tests for the passthrough spawn builder. D060 Phase 1 task 1.6.
 *
 * Passthrough is the no-backend / mode=disabled fallback path. It
 * MUST still enforce the env taxonomy — a missing backend doesn't
 * mean "let LD_PRELOAD through." These tests lock that in.
 *
 * Port-of-port reference: Spacebot src/sandbox.rs:716-784
 * (wrap_passthrough), minus the Linux session-keyring isolation
 * deferred to D041.
 */

import { describe, expect, test } from "bun:test";
import { buildPassthrough } from "../../src/passthrough";
import type { SandboxConfig } from "../../src/types";

function baseOpts(overrides: Partial<Parameters<typeof buildPassthrough>[0]> = {}) {
  return {
    workspace: "/tmp/ws",
    toolsBin: "/tmp/tools-bin",
    config: {
      mode: "disabled",
      writablePaths: [],
      projectPaths: [],
      passthroughEnv: [],
    } satisfies SandboxConfig,
    cwd: "/tmp",
    commandEnv: {},
    program: "ls",
    args: ["/"],
    ...overrides,
  };
}

describe("buildPassthrough — shape", () => {
  test("returns program/args/cwd verbatim, env as Record (not null)", () => {
    const r = buildPassthrough(baseOpts({ program: "cat", args: ["file.txt"] }));
    expect(r.program).toBe("cat");
    expect(r.args).toEqual(["file.txt"]);
    expect(r.cwd).toBe("/tmp");
    expect(r.env).not.toBeNull();
    expect(typeof r.env).toBe("object");
  });
});

describe("buildPassthrough — hardened env defaults", () => {
  test("sets PATH, HOME, TMPDIR, CI, DEBIAN_FRONTEND", () => {
    const env = buildPassthrough(baseOpts()).env as Record<string, string>;
    expect(env["PATH"]).toBeDefined();
    expect(env["PATH"]?.startsWith("/tmp/tools-bin")).toBe(true);
    expect(env["HOME"]).toBeDefined();
    expect(env["TMPDIR"]).toBeDefined();
    expect(env["CI"]).toBe("true");
    expect(env["DEBIAN_FRONTEND"]).toBe("noninteractive");
  });

  test("HOME: prefers parent's HOME when present", () => {
    const prior = process.env["HOME"];
    process.env["HOME"] = "/Users/tester";
    try {
      const env = buildPassthrough(baseOpts()).env as Record<string, string>;
      expect(env["HOME"]).toBe("/Users/tester");
    } finally {
      if (prior === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prior;
    }
  });

  test("HOME: falls back to workspace when parent's is empty/unset", () => {
    const prior = process.env["HOME"];
    delete process.env["HOME"];
    try {
      const env = buildPassthrough(baseOpts({ workspace: "/mnt/ws" })).env as Record<
        string,
        string
      >;
      expect(env["HOME"]).toBe("/mnt/ws");
    } finally {
      if (prior !== undefined) process.env["HOME"] = prior;
    }
  });

  test("TMPDIR: prefers parent's TMPDIR, falls back to /tmp", () => {
    const prior = process.env["TMPDIR"];
    process.env["TMPDIR"] = "/custom/tmp";
    try {
      const env = buildPassthrough(baseOpts()).env as Record<string, string>;
      expect(env["TMPDIR"]).toBe("/custom/tmp");
    } finally {
      if (prior === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = prior;
    }

    delete process.env["TMPDIR"];
    try {
      const env2 = buildPassthrough(baseOpts()).env as Record<string, string>;
      expect(env2["TMPDIR"]).toBe("/tmp");
    } finally {
      if (prior !== undefined) process.env["TMPDIR"] = prior;
    }
  });
});

describe("buildPassthrough — env taxonomy enforcement", () => {
  test("passthroughEnv forwards user-configured names, skips RESERVED", () => {
    const prior = process.env["MY_TEST_VAR"];
    process.env["MY_TEST_VAR"] = "hello";
    try {
      const env = buildPassthrough(
        baseOpts({
          config: {
            mode: "disabled",
            writablePaths: [],
            projectPaths: [],
            passthroughEnv: ["MY_TEST_VAR", "PATH", "USER"], // PATH reserved; USER is SAFE (also reserved)
          },
        }),
      ).env as Record<string, string>;
      expect(env["MY_TEST_VAR"]).toBe("hello");
      // PATH is the hardened default, not the parent's — check prefix match
      expect(env["PATH"]?.startsWith("/tmp/tools-bin")).toBe(true);
    } finally {
      if (prior === undefined) delete process.env["MY_TEST_VAR"];
      else process.env["MY_TEST_VAR"] = prior;
    }
  });

  test("commandEnv: user vars emitted, RESERVED skipped, DANGEROUS dropped", () => {
    const env = buildPassthrough(
      baseOpts({
        commandEnv: {
          USER_OVERRIDE: "value",
          PATH: "should-not-override",
          LD_PRELOAD: "/tmp/evil.so",
          DYLD_INSERT_LIBRARIES: "/tmp/mac-evil.dylib",
          // Case-insensitive match on DANGEROUS
          pythonpath: "should-drop",
        },
      }),
    ).env as Record<string, string>;
    expect(env["USER_OVERRIDE"]).toBe("value");
    // PATH remains the hardened default
    expect(env["PATH"]?.startsWith("/tmp/tools-bin")).toBe(true);
    // DANGEROUS not present (exact-case match on key since we iterate)
    expect(env["LD_PRELOAD"]).toBeUndefined();
    expect(env["DYLD_INSERT_LIBRARIES"]).toBeUndefined();
    expect(env["pythonpath"]).toBeUndefined();
  });

  test("SAFE vars (USER, LANG, TERM) forwarded from parent when present", () => {
    const prior = process.env["LANG"];
    process.env["LANG"] = "en_US.UTF-8";
    try {
      const env = buildPassthrough(baseOpts()).env as Record<string, string>;
      expect(env["LANG"]).toBe("en_US.UTF-8");
    } finally {
      if (prior === undefined) delete process.env["LANG"];
      else process.env["LANG"] = prior;
    }
  });
});
