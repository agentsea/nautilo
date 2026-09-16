/**
 * Stack 198 / M161 Phase 5 — pin `parseProfileFromArgv` behavior including
 * the `NAUTILO_PROFILE` env fallback and the argv/env agreement rule.
 *
 * Load-bearing: the argv path MUST remain the canonical validator (the
 * env path routes through the same slug check), and a present env MUST
 * NOT silently override a disagreeing argv.
 */
import { describe, expect, test } from "bun:test";
import { parseProfileFromArgv } from "../../electron/auth/profile-from-argv";

describe("parseProfileFromArgv — argv path", () => {
  test("absent flag and absent env → undefined", () => {
    expect(parseProfileFromArgv(["electron", "dist/main.js"], {})).toBeUndefined();
  });

  test("absent flag and absent env → undefined even with process.env default", () => {
    expect(parseProfileFromArgv(["electron", "dist/main.js"])).toBeUndefined();
  });

  test("--profile <slug> → slug (lowercased)", () => {
    expect(parseProfileFromArgv(["--profile", "work"], {})).toBe("work");
  });

  test("--profile rejects uppercase (slug must already be lowercase)", () => {
    expect(() => parseProfileFromArgv(["--profile", "Work"], {})).toThrow(/Invalid/);
  });

  test("--profile with surrounding whitespace is trimmed", () => {
    expect(parseProfileFromArgv(["--profile", "  work  "], {})).toBe("work");
  });

  test("missing value after --profile throws", () => {
    expect(() => parseProfileFromArgv(["--profile"], {})).toThrow(/Missing value/);
  });

  test("flag-like value after --profile throws (not swallowed as flag)", () => {
    expect(() => parseProfileFromArgv(["--profile", "--other"], {})).toThrow(/Missing value/);
  });

  test("invalid slug characters throw", () => {
    expect(() => parseProfileFromArgv(["--profile", "Work!"], {})).toThrow(/Invalid/);
  });

  test("overlong slug (>32 chars) throws", () => {
    expect(() => parseProfileFromArgv(["--profile", "a".repeat(33)], {})).toThrow(/Invalid/);
  });
});

describe("parseProfileFromArgv — NAUTILO_PROFILE env fallback", () => {
  test("env only → slug (lowercased)", () => {
    expect(parseProfileFromArgv(["electron", "dist/main.js"], { NAUTILO_PROFILE: "work" })).toBe(
      "work",
    );
  });

  test("env uppercase is rejected (same validator as argv)", () => {
    expect(() => parseProfileFromArgv(["electron"], { NAUTILO_PROFILE: "Work" })).toThrow(/Invalid/);
  });

  test("env with surrounding whitespace is trimmed", () => {
    expect(parseProfileFromArgv(["electron"], { NAUTILO_PROFILE: "  work  " })).toBe("work");
  });

  test("empty-string env is treated as absent (no trailing-dash profile)", () => {
    expect(parseProfileFromArgv(["electron"], { NAUTILO_PROFILE: "" })).toBeUndefined();
  });

  test("invalid env slug throws (same validator as argv)", () => {
    expect(() => parseProfileFromArgv(["electron"], { NAUTILO_PROFILE: "Work!" })).toThrow(
      /Invalid/,
    );
  });
});

describe("parseProfileFromArgv — argv / env agreement", () => {
  test("argv and env agree (same slug) → ok", () => {
    expect(parseProfileFromArgv(["--profile", "work"], { NAUTILO_PROFILE: "work" })).toBe("work");
  });

  test("argv and whitespace-trimmed env agree after canonical validation", () => {
    expect(parseProfileFromArgv(["--profile", "work"], { NAUTILO_PROFILE: "  work  " })).toBe(
      "work",
    );
  });

  test("malformed env throws even when argv is valid", () => {
    expect(() =>
      parseProfileFromArgv(["--profile", "work"], { NAUTILO_PROFILE: "work!" }),
    ).toThrow(/Invalid/);
  });

  test("uppercase env throws even when its lowercase form matches argv", () => {
    expect(() =>
      parseProfileFromArgv(["--profile", "work"], { NAUTILO_PROFILE: "Work" }),
    ).toThrow(/Invalid/);
  });

  test("argv and env disagree → throws (one source of truth)", () => {
    expect(() =>
      parseProfileFromArgv(["--profile", "work"], { NAUTILO_PROFILE: "personal" }),
    ).toThrow(/disagree/);
  });
});
