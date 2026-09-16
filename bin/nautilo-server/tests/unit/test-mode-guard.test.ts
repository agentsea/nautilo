/**
 * PR-014 MAJOR #3 — boot-time env-var coupling guard.
 *
 * `NAUTILO_TEST_MODE_ONLY=1` without `NAUTILO_TEST_MODE=1` produces a
 * running server bound to a port with zero functional API routes
 * (DB skipped → no auth/chat/approval; test-mode routes disabled by
 * `resolveTestToken()` returning null; `testModeRoutes({ enabled:
 * false })` early-returns). The guard catches this misconfiguration
 * at boot before systemd / the operator burns a 60s health-gate
 * timeout trying to figure out why the server looks alive but
 * doesn't serve anything.
 *
 * These tests lock each cell of the 2x2 matrix + the exact error
 * shape, so a future refactor can't silently relax the coupling.
 */

import { describe, expect, test } from "bun:test";

import {
  assertProductionBuildPolicy,
  assertTestModeCoupling,
} from "../../src/test-mode-guard";

describe("assertTestModeCoupling — PR-014 MAJOR #3", () => {
  test("production boot (both unset) → ok", () => {
    const r = assertTestModeCoupling({});
    expect(r.ok).toBe(true);
  });

  test("full boot with test-mode surface (TEST_MODE=1 alone) → ok", () => {
    // Normal dev-mode boot: full DB + test-mode routes accessible.
    const r = assertTestModeCoupling({ NAUTILO_TEST_MODE: "1" });
    expect(r.ok).toBe(true);
  });

  test("in-VM test harness boot (both set) → ok", () => {
    // The canonical happy path — `setup-linux.sh`'s systemd unit
    // ships exactly this pair.
    const r = assertTestModeCoupling({
      NAUTILO_TEST_MODE: "1",
      NAUTILO_TEST_MODE_ONLY: "1",
    });
    expect(r.ok).toBe(true);
  });

  test("TEST_MODE_ONLY=1 alone (footgun) → refused with instructive message", () => {
    // This is THE bug the guard exists to catch. A mis-provisioned
    // systemd unit or an ad-hoc launcher that sets TEST_MODE_ONLY
    // without TEST_MODE boots a zombie server. The guard refuses.
    const r = assertTestModeCoupling({ NAUTILO_TEST_MODE_ONLY: "1" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected refusal");
    expect(r.code).toBe("TEST_MODE_ONLY_WITHOUT_TEST_MODE");
    // Instructive-message contract — systemd journal readers need to
    // see BOTH the problem AND the fix. A terse "coupling violation"
    // without the fix is unhelpful at 2am.
    expect(r.message).toContain("NAUTILO_TEST_MODE=1");
    expect(r.message).toContain("Environment=");
    expect(r.message).toContain("systemd unit");
  });

  test("TEST_MODE_ONLY=0 (explicit off) alone → ok", () => {
    // Defensive: the check should read === "1", not "truthy".
    // Values other than "1" (empty string, "0", "true", "yes") do
    // NOT activate TEST_MODE_ONLY, so the coupling doesn't trip.
    const r = assertTestModeCoupling({ NAUTILO_TEST_MODE_ONLY: "0" });
    expect(r.ok).toBe(true);
  });

  test("TEST_MODE_ONLY='true' (common typo) → treated as off, ok", () => {
    // `=== "1"` is strict by design — avoids activating on shell
    // truthy patterns like `TEST_MODE_ONLY=true`.
    const r = assertTestModeCoupling({ NAUTILO_TEST_MODE_ONLY: "true" });
    expect(r.ok).toBe(true);
  });

  test("TEST_MODE_ONLY with whitespace-trimmed '1' NOT special-cased", () => {
    // Deliberate: the coupling check mirrors the downstream check
    // at test-mode.ts:228 (`=== "1"`) to avoid drift. If one side
    // trims and the other doesn't, a leading-whitespace value would
    // pass one gate and fail the other — worse than either policy
    // alone.
    const r = assertTestModeCoupling({ NAUTILO_TEST_MODE_ONLY: " 1" });
    expect(r.ok).toBe(true); // " 1" !== "1" → flag not active → no coupling needed
  });

  test("extra unrelated env vars don't affect the check", () => {
    // Isolation: the guard only reads its two flags.
    const r = assertTestModeCoupling({
      NAUTILO_TEST_MODE: "1",
      NAUTILO_TEST_MODE_ONLY: "1",
      NAUTILO_PORT: "3001",
      PATH: "/usr/bin",
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D060 Sprint 1 G5.6 — production-build policy
// ---------------------------------------------------------------------------

describe("assertProductionBuildPolicy — D060 G5.6", () => {
  test("NODE_ENV=development honors test-mode vars (dev loop)", () => {
    const r = assertProductionBuildPolicy({
      NODE_ENV: "development",
      NAUTILO_TEST_MODE: "1",
      NAUTILO_TEST_MODE_ONLY: "1",
      NAUTILO_TEST_TOKEN: "dev-token",
    });
    expect(r.ok).toBe(true);
  });

  test("NODE_ENV undefined treated as non-production (default dev loop)", () => {
    const r = assertProductionBuildPolicy({
      NAUTILO_TEST_MODE: "1",
    });
    expect(r.ok).toBe(true);
  });

  test("NODE_ENV=production with no test-mode vars → ok", () => {
    const r = assertProductionBuildPolicy({ NODE_ENV: "production" });
    expect(r.ok).toBe(true);
  });

  test("NODE_ENV=production + NAUTILO_TEST_MODE=1 → panic", () => {
    const r = assertProductionBuildPolicy({
      NODE_ENV: "production",
      NAUTILO_TEST_MODE: "1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.code).toBe("TEST_MODE_VAR_IN_PRODUCTION");
    expect(r.attemptedVars).toEqual(["NAUTILO_TEST_MODE"]);
    expect(r.message).toContain("NODE_ENV=production");
    expect(r.message).toContain("NAUTILO_TEST_MODE");
  });

  test("NODE_ENV=production + all three vars set → panic with all names listed", () => {
    const r = assertProductionBuildPolicy({
      NODE_ENV: "production",
      NAUTILO_TEST_MODE: "1",
      NAUTILO_TEST_MODE_ONLY: "1",
      NAUTILO_TEST_TOKEN: "leaked",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.attemptedVars).toEqual([
      "NAUTILO_TEST_MODE",
      "NAUTILO_TEST_MODE_ONLY",
      "NAUTILO_TEST_TOKEN",
    ]);
  });

  test("NODE_ENV=production + empty-string test-mode var → ok (not set)", () => {
    // Ship plan §5.6 red-team test: `set NAUTILO_SANDBOX_RELAY=0` in
    // release build expects NO effect. Mirror that: an empty or
    // explicitly-unset var shouldn\u0027t trigger the panic. Only
    // non-empty values are "attempted".
    const r = assertProductionBuildPolicy({
      NODE_ENV: "production",
      NAUTILO_TEST_MODE: "",
    });
    expect(r.ok).toBe(true);
  });

  test("NODE_ENV=production + NAUTILO_TEST_MODE=0 → panic (any value triggers)", () => {
    // Unlike the coupling check\u0027s `=== "1"` strictness, the
    // production-policy check treats ANY non-empty value as an
    // attempt. A prompt-injected attacker setting TEST_MODE=0 in
    // the hope that "falsy" bypasses the check doesn\u0027t work.
    const r = assertProductionBuildPolicy({
      NODE_ENV: "production",
      NAUTILO_TEST_MODE: "0",
    });
    expect(r.ok).toBe(false);
  });

  test("NODE_ENV=production + only NAUTILO_TEST_TOKEN set → panic", () => {
    // Edge: token alone is useless (no test-mode routes) but it
    // still shouldn\u0027t be present in a release build. Panics to
    // force the operator to clean up the environment.
    const r = assertProductionBuildPolicy({
      NODE_ENV: "production",
      NAUTILO_TEST_TOKEN: "stale-token-from-staging",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("narrow");
    expect(r.attemptedVars).toEqual(["NAUTILO_TEST_TOKEN"]);
  });

  test("unrelated env vars (NAUTILO_SECURITY_LEVEL) don't panic — those are deleted reads, not checked here", () => {
    // Discipline: this function only polices the three known test-
    // mode vars. Policy-affecting vars are handled by deletion +
    // the ESLint rule (G5.6 part 3), not by a runtime panic. This
    // test locks the scope so someone doesn\u0027t expand the panic
    // list without updating the doc.
    const r = assertProductionBuildPolicy({
      NODE_ENV: "production",
      NAUTILO_SECURITY_LEVEL: "yolo",
      NAUTILO_SANDBOX_RELAY: "0",
    });
    expect(r.ok).toBe(true);
  });
});
