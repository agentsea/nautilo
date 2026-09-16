/**
 * Stack 198 / D266 Wave 1 — proves `setupOwnerAppFixture` (the server shared
 * app-fixture seam) runs the routing guard BEFORE `ensureDatabase()` /
 * `createDirectDb()`, so it cannot resolve the protected `(default)`
 * operator DB without the explicit `ALLOW_DEFAULT_DB_TESTS=1` escape hatch.
 *
 * The server `tests/unit/` directory forbids `mock.module` (see
 * `mock-module-isolation-guard.test.ts`), so this file is mock-free: it
 * asserts the guard throws the standard refusal message on a protected
 * target, which happens synchronously before any DB connection is opened.
 * No live operator DB is opened or mutated. Routing of the unset / scratch /
 * named cases through the seam is covered by `bootstrapTestDbInstance`'s own
 * unit tests (`packages/db/tests/unit/instance-guard.test.ts`) and by the
 * runtime seam test (`packages/runtime/tests/unit/setup-test-db-routing.test.ts`),
 * which can mock `ensureDatabase` to drive the seam without a DB.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOW_DEFAULT_DB_TESTS_ENV,
  DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
} from "../helpers/default-db-fixture-guard";
import { setupOwnerAppFixture } from "../integration/helpers/app-fixture";

const CI_KEYS = ["CI", "GITHUB_ACTIONS", "CONTINUOUS_INTEGRATION"] as const;
const GUARD_KEYS = [
  "NAUTILO_INSTANCE_ID",
  ALLOW_DEFAULT_DB_TESTS_ENV,
  ...CI_KEYS,
] as const;

type Env = Record<string, string | undefined>;

function snapshotEnv(): Env {
  const snap: Env = {};
  for (const key of GUARD_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Env): void {
  for (const key of GUARD_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

function withEnv(overrides: Env, fn: () => void): void {
  const snap = snapshotEnv();
  for (const key of GUARD_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    restoreEnv(snap);
  }
}

describe("setupOwnerAppFixture — D266 Wave 1 routing guard", () => {
  test("explicit `default` is refused before ensureDatabase / createDirectDb", () => {
    withEnv({ NAUTILO_INSTANCE_ID: "default" }, () => {
      expect(() => setupOwnerAppFixture({ suiteName: "d266-refuse-default" })).toThrow(
        DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
      );
    });
  });

  test("`(default)` alias is refused before ensureDatabase / createDirectDb", () => {
    withEnv({ NAUTILO_INSTANCE_ID: "(default)" }, () => {
      expect(() => setupOwnerAppFixture({ suiteName: "d266-refuse-alias" })).toThrow(
        DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
      );
    });
  });
});
