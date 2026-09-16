/**
 * Tests for the D073 runtime allowlist — D060 Sprint 2 G5.
 */

import { describe, expect, test } from "bun:test";
import {
  RUNTIME_ALLOWLIST,
  detectRuntime,
  listSupportedExtensions,
} from "../../src/tools/execute-artifact/runtimes";

describe("detectRuntime", () => {
  test("maps .py to python3 via env", () => {
    const rt = detectRuntime("analysis.py");
    expect(rt).not.toBeNull();
    if (!rt) throw new Error("narrow");
    expect(rt.program).toBe("/usr/bin/env");
    expect(rt.preScriptArgs).toEqual(["python3"]);
    expect(rt.argvSeparator).toEqual(["--"]);
  });

  test("maps .ts to bun run", () => {
    const rt = detectRuntime("scripts/run.ts");
    expect(rt?.preScriptArgs).toEqual(["bun", "run"]);
  });

  test("maps .js and .mjs to node", () => {
    expect(detectRuntime("a.js")?.preScriptArgs).toEqual(["node"]);
    expect(detectRuntime("b.mjs")?.preScriptArgs).toEqual(["node"]);
  });

  test("maps .sh to /bin/sh (absolute, no env)", () => {
    const rt = detectRuntime("run.sh");
    expect(rt?.program).toBe("/bin/sh");
    expect(rt?.preScriptArgs).toEqual([]);
    expect(rt?.argvSeparator).toEqual([]);
  });

  test("maps .bash to /bin/bash", () => {
    expect(detectRuntime("setup.bash")?.program).toBe("/bin/bash");
  });

  test("maps .rb to ruby via env", () => {
    expect(detectRuntime("task.rb")?.preScriptArgs).toEqual(["ruby"]);
  });

  test("maps .r and .R to Rscript with --args separator", () => {
    const lower = detectRuntime("stats.r");
    expect(lower?.preScriptArgs).toEqual(["Rscript"]);
    expect(lower?.argvSeparator).toEqual(["--args"]);
    const upper = detectRuntime("stats.R");
    expect(upper?.preScriptArgs).toEqual(["Rscript"]);
  });

  test("rejects compiled-binary extensions", () => {
    expect(detectRuntime("tool.exe")).toBeNull();
    expect(detectRuntime("library.so")).toBeNull();
    expect(detectRuntime("binary.out")).toBeNull();
  });

  test("rejects extensionless paths", () => {
    expect(detectRuntime("Makefile")).toBeNull();
    expect(detectRuntime("Dockerfile")).toBeNull();
  });

  test("rejects trailing-dot paths (no extension)", () => {
    expect(detectRuntime("script.")).toBeNull();
  });

  test("handles case variations on extension", () => {
    // `.PY` and `.Py` → python3 (extension match is case-insensitive)
    expect(detectRuntime("ANALYSIS.PY")?.preScriptArgs).toEqual(["python3"]);
    expect(detectRuntime("Mixed.Py")?.preScriptArgs).toEqual(["python3"]);
  });

  test("dot in directory name doesn\u0027t confuse ext detection", () => {
    // `some.dir/script.py` — the last dot is the script\u0027s, not
    // the directory\u0027s. Detection takes the substring after the
    // LAST dot in the full path.
    const rt = detectRuntime("some.dir/script.py");
    expect(rt?.preScriptArgs).toEqual(["python3"]);
  });
});

describe("RUNTIME_ALLOWLIST invariants", () => {
  test("every interpreter has an absolute program path", () => {
    for (const [ext, spec] of Object.entries(RUNTIME_ALLOWLIST)) {
      if (!spec.program.startsWith("/")) {
        throw new Error(
          `runtime for .${ext} has non-absolute program path: ${spec.program}`,
        );
      }
    }
  });

  test("extension keys are lowercase + dot-free", () => {
    for (const key of Object.keys(RUNTIME_ALLOWLIST)) {
      expect(key).toBe(key.toLowerCase());
      expect(key.startsWith(".")).toBe(false);
    }
  });
});

describe("listSupportedExtensions", () => {
  test("stable-sorted comma-separated format", () => {
    const list = listSupportedExtensions();
    // Should be dot-prefixed, sorted. Presence-test key entries.
    expect(list).toContain(".py");
    expect(list).toContain(".ts");
    expect(list).toContain(".sh");
    // Sort check: `.bash` comes before `.py` alphabetically.
    const idxBash = list.indexOf(".bash");
    const idxPy = list.indexOf(".py");
    expect(idxBash).toBeLessThan(idxPy);
  });
});
