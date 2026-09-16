/**
 * D060 Phase 1 — env-var coupling guard for the in-VM test-mode boot
 * path.
 *
 * `NAUTILO_TEST_MODE_ONLY=1` is an optimization that skips DB + seed
 * + policy + checkpoint at boot. It layers on top of the normal
 * test-mode surface (`NAUTILO_TEST_MODE=1` + bearer token). Without
 * `NAUTILO_TEST_MODE=1` the test-mode routes don't register, so
 * `TEST_MODE_ONLY=1` alone produces a server that binds a port but
 * serves zero usable API routes — a footgun that looks like a
 * downstream wiring bug.
 *
 * PR-014 MAJOR #3 — assertTestModeCoupling refuses the bad combo at
 * boot so systemd journals / docker logs / ad-hoc launchers surface
 * the real cause on exit instead of hiding it behind silent
 * degradation.
 *
 * Extracted into its own module so unit tests can drive it with a
 * mock env record without round-tripping through the real boot path
 * (which top-level-awaits DB + policy + checkpoint setup that a unit
 * harness has no business exercising).
 */

/**
 * Signal returned instead of throwing so the caller (`bin/nautilo-server/src/index.ts`)
 * can decide whether to `process.exit(2)` or re-raise. Exiting is
 * wrong inside a test; a plain throw is awkward in a top-level-await
 * boot path. A tagged result keeps both caller surfaces clean.
 */
export type TestModeCouplingResult =
  | { ok: true }
  | {
      ok: false;
      code: "TEST_MODE_ONLY_WITHOUT_TEST_MODE";
      message: string;
    };

/**
 * Result of the G5.6 production-build policy check. Returned tagged
 * (not thrown) for the same reason as `TestModeCouplingResult`.
 */
export type ProductionBuildPolicyResult =
  | { ok: true }
  | {
      ok: false;
      code: "TEST_MODE_VAR_IN_PRODUCTION";
      /** The offending env var names, for the error message + future
       *  audit row (ship plan §5.8 `env_var_attempt`). */
      readonly attemptedVars: readonly string[];
      message: string;
    };

/**
 * D060 Sprint 1 G5.6 (ship plan v3 §5.6) — the test-mode env vars
 * (`NAUTILO_TEST_MODE`, `NAUTILO_TEST_MODE_ONLY`, `NAUTILO_TEST_TOKEN`)
 * are LEGAL ONLY in non-production builds. The `red-team test`
 * scenario in the ship plan §11: set any of them in a release build
 * and expect the server to hard-panic at boot. This function is
 * that panic — the caller (index.ts) wires it to `process.exit(2)`
 * with the single-line error surfaced in systemd/docker logs.
 *
 * Why a runtime check when G5.6 part 3 also ships a compile-time
 * strip via the ESLint rule + bundler config? Defense in depth:
 * the ESLint rule prevents new `process.env["NAUTILO_TEST_MODE"]`
 * READS, but env vars are SET from outside the binary. A release
 * build with the reads compile-stripped would ignore the var
 * silently; we want to FAIL LOUD so a misconfigured deploy can\u0027t
 * accidentally ship with test mode active.
 *
 * The check runs in production builds only — dev builds + tests
 * honor test-mode vars as normal.
 */
const TEST_MODE_VAR_NAMES = [
  "NAUTILO_TEST_MODE",
  "NAUTILO_TEST_MODE_ONLY",
  "NAUTILO_TEST_TOKEN",
] as const;

export function assertProductionBuildPolicy(
  env: Readonly<Record<string, string | undefined>>,
): ProductionBuildPolicyResult {
  if (env["NODE_ENV"] !== "production") {
    // Non-production build: test-mode vars are legal. The existing
    // `assertTestModeCoupling` check still runs downstream.
    return { ok: true };
  }

  const attempted = TEST_MODE_VAR_NAMES.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
  if (attempted.length === 0) return { ok: true };

  return {
    ok: false,
    code: "TEST_MODE_VAR_IN_PRODUCTION",
    attemptedVars: attempted,
    message:
      `[server] ABORT — NAUTILO test-mode env var set in a release build ` +
      `(NODE_ENV=production): ${attempted.join(", ")}. Test-mode ` +
      `variables are development-only. Either unset them, or rebuild ` +
      `the server with NODE_ENV=development if you actually want a ` +
      `dev instance. Release builds cannot enable development test routes.`,
  };
}

/**
 * Check the two env vars for consistency.
 *
 * Valid combinations:
 *   - TEST_MODE=0, TEST_MODE_ONLY=0 → production boot; ok
 *   - TEST_MODE=1, TEST_MODE_ONLY=0 → full boot with test routes; ok
 *   - TEST_MODE=1, TEST_MODE_ONLY=1 → in-VM test harness boot; ok
 *
 * Invalid:
 *   - TEST_MODE=0, TEST_MODE_ONLY=1 → degraded server; REFUSED
 *
 * Dependency-injected `env` rather than reading process.env directly
 * so tests don't have to mutate shared module state.
 */
export function assertTestModeCoupling(
  env: Readonly<Record<string, string | undefined>>,
): TestModeCouplingResult {
  const testMode = env["NAUTILO_TEST_MODE"] === "1";
  const testModeOnly = env["NAUTILO_TEST_MODE_ONLY"] === "1";
  if (testModeOnly && !testMode) {
    return {
      ok: false,
      code: "TEST_MODE_ONLY_WITHOUT_TEST_MODE",
      message:
        "NAUTILO_TEST_MODE_ONLY=1 requires NAUTILO_TEST_MODE=1 to be set too. " +
        "TEST_MODE_ONLY is a DB/seed/policy-skip optimization layered on top of " +
        "the normal test-mode surface; by itself it produces a server that binds " +
        "a port but serves no usable routes. If you are provisioning an in-VM " +
        "test server, add `Environment=NAUTILO_TEST_MODE=1` to your systemd unit " +
        "(or export it alongside TEST_MODE_ONLY in your launcher script).",
    };
  }
  return { ok: true };
}
