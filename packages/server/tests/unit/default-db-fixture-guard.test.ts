/**
 * ISSUE-D202 Wave 3 — fixture guard refuses protected `(default)` locally.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOW_DEFAULT_DB_TESTS_ENV,
  DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
  RECOMMENDED_SCRATCH_INSTANCE,
  assertFixtureDbMutationAllowed,
  evaluateFixtureDbMutationGuard,
  isCiTestEnvironment,
  resolveEffectiveDbInstanceId,
} from "../helpers/default-db-fixture-guard";
import { setupOwnerAppFixture } from "../integration/helpers/app-fixture";

const CI_KEYS = ["CI", "GITHUB_ACTIONS", "CONTINUOUS_INTEGRATION"] as const;

function localLikeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CI_KEYS) {
    if (!(key in overrides)) delete env[key];
  }
  if (!(ALLOW_DEFAULT_DB_TESTS_ENV in overrides)) {
    delete env[ALLOW_DEFAULT_DB_TESTS_ENV];
  }
  return { ...env, ...overrides };
}

describe("default-db-fixture-guard", () => {
  test("default instance without override is refused before fixture DB work", () => {
    const env = localLikeEnv({ NAUTILO_INSTANCE_ID: "" });
    const decision = evaluateFixtureDbMutationGuard(env);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toBe(DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE);
      expect(decision.message).toContain(RECOMMENDED_SCRATCH_INSTANCE);
    }
    expect(() => assertFixtureDbMutationAllowed(env)).toThrow(
      DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
    );
  });

  test("default instance with ALLOW_DEFAULT_DB_TESTS=1 is allowed", () => {
    const env = localLikeEnv({
      NAUTILO_INSTANCE_ID: "",
      [ALLOW_DEFAULT_DB_TESTS_ENV]: "1",
    });
    const decision = evaluateFixtureDbMutationGuard(env);
    expect(decision.allowed).toBe(true);
    expect(() => assertFixtureDbMutationAllowed(env)).not.toThrow();
  });

  test("named scratch instance is allowed", () => {
    const env = localLikeEnv({
      NAUTILO_INSTANCE_ID: RECOMMENDED_SCRATCH_INSTANCE,
    });
    expect(resolveEffectiveDbInstanceId(env)).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    const decision = evaluateFixtureDbMutationGuard(env);
    expect(decision.allowed).toBe(true);
    expect(decision.isDefaultInstance).toBe(false);
  });

  test("NAUTILO_INSTANCE_ID=default alias resolves to protected default", () => {
    const env = localLikeEnv({ NAUTILO_INSTANCE_ID: "default" });
    expect(resolveEffectiveDbInstanceId(env)).toBe("");
    const decision = evaluateFixtureDbMutationGuard(env);
    expect(decision.allowed).toBe(false);
  });

  test("CI environment allows default-targeting fixtures", () => {
    const env = localLikeEnv({ NAUTILO_INSTANCE_ID: "", CI: "true" });
    expect(isCiTestEnvironment(env)).toBe(true);
    expect(evaluateFixtureDbMutationGuard(env).allowed).toBe(true);
  });
});

describe("setupOwnerAppFixture default guard", () => {
  test("setupOwnerAppFixture throws on default before ensureDatabase", () => {
    const prev: Record<string, string | undefined> = {
      NAUTILO_INSTANCE_ID: process.env["NAUTILO_INSTANCE_ID"],
      [ALLOW_DEFAULT_DB_TESTS_ENV]: process.env[ALLOW_DEFAULT_DB_TESTS_ENV],
      CI: process.env["CI"],
      GITHUB_ACTIONS: process.env["GITHUB_ACTIONS"],
      CONTINUOUS_INTEGRATION: process.env["CONTINUOUS_INTEGRATION"],
    };
    try {
      for (const key of Object.keys(prev)) delete process.env[key];
      process.env["NAUTILO_INSTANCE_ID"] = "default";
      expect(() => setupOwnerAppFixture({ suiteName: "d202-refuse" })).toThrow(
        DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
      );
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
