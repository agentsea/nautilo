/**
 * Unit tests for the env-var taxonomy. D060 Phase 1 task 1.2.
 *
 * The constant lists are load-bearing for sandbox correctness — a
 * regression here silently weakens defense-in-depth against
 * LD_PRELOAD / DYLD_INSERT_LIBRARIES / PYTHONPATH attacks. Assert on
 * the content so future edits require explicit intent.
 */

import { describe, expect, test } from "bun:test";
import {
  DANGEROUS_ENV_VARS,
  RESERVED_ENV_VARS,
  SAFE_ENV_VARS,
  isDangerousEnvVar,
  isReservedEnvVar,
} from "../../src/env-vars";

describe("constants", () => {
  test("SAFE_ENV_VARS — minimal set for subprocess basics", () => {
    expect([...SAFE_ENV_VARS]).toEqual(["USER", "LANG", "TERM"]);
  });

  test("RESERVED_ENV_VARS — hardened defaults plus D103 proxy ownership", () => {
    expect([...RESERVED_ENV_VARS]).toEqual([
      "PATH",
      "HOME",
      "TMPDIR",
      "CI",
      "DEBIAN_FRONTEND",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
    ]);
  });

  test("DANGEROUS_ENV_VARS — 12 injection vectors, Spacebot-canonical", () => {
    // Assert the exact list so accidental deletion trips a test. If
    // adding new entries is appropriate, update this test in the
    // same commit (explicit intent).
    expect([...DANGEROUS_ENV_VARS]).toEqual([
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "NODE_OPTIONS",
      "RUBYOPT",
      "PERL5OPT",
      "PERL5LIB",
      "BASH_ENV",
      "ENV",
    ]);
  });

  test("SAFE and RESERVED do not overlap", () => {
    // Widen via `Set<string>` so the `.has()` predicate accepts any
    // string rather than constraining to each list's literal tuple.
    const reserved = new Set<string>(RESERVED_ENV_VARS);
    for (const name of SAFE_ENV_VARS) {
      expect(reserved.has(name)).toBe(false);
    }
  });

  test("DANGEROUS does not overlap SAFE/RESERVED (different posture)", () => {
    const owned = new Set<string>([...SAFE_ENV_VARS, ...RESERVED_ENV_VARS]);
    for (const name of DANGEROUS_ENV_VARS) {
      expect(owned.has(name)).toBe(false);
    }
  });
});

describe("isReservedEnvVar", () => {
  test("each RESERVED name is reserved", () => {
    for (const name of RESERVED_ENV_VARS) {
      expect(isReservedEnvVar(name)).toBe(true);
    }
  });

  test("each SAFE name is reserved (the union predicate)", () => {
    for (const name of SAFE_ENV_VARS) {
      expect(isReservedEnvVar(name)).toBe(true);
    }
  });

  test("arbitrary user var is NOT reserved", () => {
    expect(isReservedEnvVar("MY_APP_CONFIG")).toBe(false);
    expect(isReservedEnvVar("GITHUB_TOKEN")).toBe(false);
    expect(isReservedEnvVar("")).toBe(false);
  });

  test("case-sensitive — 'path' is not 'PATH'", () => {
    // POSIX treats env var names case-sensitively. Reserved check
    // must too so a user's `path` var (rare but legal) isn't
    // silently blocked.
    expect(isReservedEnvVar("path")).toBe(false);
    expect(isReservedEnvVar("home")).toBe(false);
  });
});

describe("isDangerousEnvVar", () => {
  test("each DANGEROUS name matches", () => {
    for (const name of DANGEROUS_ENV_VARS) {
      expect(isDangerousEnvVar(name)).toBe(true);
    }
  });

  test("case-INsensitive (Spacebot parity — eq_ignore_ascii_case)", () => {
    expect(isDangerousEnvVar("ld_preload")).toBe(true);
    expect(isDangerousEnvVar("Ld_PrElOaD")).toBe(true);
    expect(isDangerousEnvVar("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isDangerousEnvVar("dyld_insert_libraries")).toBe(true);
    expect(isDangerousEnvVar("node_options")).toBe(true);
  });

  test("benign var is not dangerous", () => {
    expect(isDangerousEnvVar("MY_APP_CONFIG")).toBe(false);
    expect(isDangerousEnvVar("GITHUB_TOKEN")).toBe(false);
    expect(isDangerousEnvVar("")).toBe(false);
  });

  test("substring of DANGEROUS name is NOT dangerous (equality not contains)", () => {
    // `LD_` is a prefix of LD_PRELOAD but isn't itself dangerous.
    expect(isDangerousEnvVar("LD_")).toBe(false);
    expect(isDangerousEnvVar("NODE_OPT")).toBe(false);
    expect(isDangerousEnvVar("XLD_PRELOADX")).toBe(false);
  });
});
