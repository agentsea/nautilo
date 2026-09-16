/**
 * Unit tests for security-level → sandbox-policy mapping. D060
 * Phase 1 task 1.7.
 *
 * Policy is load-bearing — paranoid MUST fail-loud when no backend is
 * available, and the three non-containing levels MUST NOT surprise
 * the operator by silently enabling a sandbox. The tests lock each
 * cell of the 5×2 level-vs-flag matrix.
 *
 * Also: type-level assertion that our local `SecurityLevel` union
 * matches `@nautilo/security`'s (which is the authoritative source).
 * If either drifts, this test file stops typechecking.
 */

import { describe, expect, test } from "bun:test";
import type { SecurityLevel as SecurityLevelFromSecurity } from "@nautilo/security";

import { sandboxPolicyForLevel, type SecurityLevel } from "../../src/security-level";

// ---------------------------------------------------------------------------
// Type-level: our SecurityLevel MUST be assignable to @nautilo/security's
// (and vice-versa). If the security package adds a level, this file fails
// typecheck and forces us to update the mapping.
// ---------------------------------------------------------------------------

// Type-level drift assertion via a function that returns a compile-time
// witness. TS noUnusedLocals accepts function declarations; referencing it
// in an expression keeps it alive without us caring about the return.
type AssertAssignable<T, U> = T extends U ? (U extends T ? true : false) : false;
function _driftCheck(): AssertAssignable<SecurityLevel, SecurityLevelFromSecurity> {
  return true;
}
// Reference so TS sees it used (without the "unused local" lint).
void _driftCheck;

describe("sandboxPolicyForLevel — non-containing levels", () => {
  test("yolo → disabled, failIfNoBackend=false", () => {
    expect(sandboxPolicyForLevel("yolo")).toEqual({
      mode: "disabled",
      failIfNoBackend: false,
    });
  });

  test("permissive → disabled, failIfNoBackend=false", () => {
    expect(sandboxPolicyForLevel("permissive")).toEqual({
      mode: "disabled",
      failIfNoBackend: false,
    });
  });

  test("standard → disabled, failIfNoBackend=false (scanner+path-deny still active upstream)", () => {
    expect(sandboxPolicyForLevel("standard")).toEqual({
      mode: "disabled",
      failIfNoBackend: false,
    });
  });
});

describe("sandboxPolicyForLevel — containing levels", () => {
  test("cautious → enabled, failIfNoBackend=false (WARN-only)", () => {
    expect(sandboxPolicyForLevel("cautious")).toEqual({
      mode: "enabled",
      failIfNoBackend: false,
    });
  });

  test("paranoid → enabled, failIfNoBackend=TRUE (fail-loud posture)", () => {
    expect(sandboxPolicyForLevel("paranoid")).toEqual({
      mode: "enabled",
      failIfNoBackend: true,
    });
  });
});

describe("sandboxPolicyForLevel — policy invariants", () => {
  test("ONLY paranoid sets failIfNoBackend=true", () => {
    const levels: SecurityLevel[] = [
      "yolo",
      "permissive",
      "standard",
      "cautious",
      "paranoid",
    ];
    const failLoud = levels.filter(
      (l) => sandboxPolicyForLevel(l).failIfNoBackend === true,
    );
    expect(failLoud).toEqual(["paranoid"]);
  });

  test("only cautious + paranoid ENABLE the sandbox", () => {
    const levels: SecurityLevel[] = [
      "yolo",
      "permissive",
      "standard",
      "cautious",
      "paranoid",
    ];
    const enabled = levels.filter(
      (l) => sandboxPolicyForLevel(l).mode === "enabled",
    );
    expect(enabled).toEqual(["cautious", "paranoid"]);
  });
});
