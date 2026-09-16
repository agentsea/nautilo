/**
 * Stack 198 / D266 Wave 1 — proves `setupTestDb` (the runtime shared DB setup
 * seam) routes via `bootstrapTestDbInstance()` BEFORE `ensureDatabase()` /
 * lazy `createDirectDb()` pool resolution, and never opens or mutates a live
 * operator DB.
 *
 * `ensureDatabase` is mocked so the seam halts right at DB resolution; the
 * real `bootstrapTestDbInstance` (pure env logic, no DB) runs unchanged and
 * its env mutations are asserted. This file runs in its own
 * `tests/unit-isolated/` Bun process because `mock.module` is process-global.
 * The factory spreads the real `@nautilo/db` barrel so every other export
 * needed by this isolated test remains available.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDb from "@nautilo/db";
import {
  DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE,
  RECOMMENDED_SCRATCH_INSTANCE,
  bootstrapTestDbInstance,
} from "@nautilo/db/testing";

const ensureDatabaseMock = mock(() => Promise.resolve());
mock.module("@nautilo/db", () => ({
  ...realDb,
  ensureDatabase: ensureDatabaseMock,
}));

const { setupTestDb, __resetSetupTestDbForTests } = await import(
  "../integration/helpers"
);

const CI_KEYS = ["CI", "GITHUB_ACTIONS", "CONTINUOUS_INTEGRATION"] as const;
const GUARD_KEYS = [
  "NAUTILO_INSTANCE_ID",
  "ALLOW_DEFAULT_DB_TESTS",
  "NAUTILO_TEST_DB_AUTOHEAL",
  "DB_DIRECT_CONNECTION",
  "DB_CONNECTION_STRING",
  "NAUTILO_DB_PORT",
  ...CI_KEYS,
] as const;

type Env = Record<string, string | undefined>;

let savedEnv: Env = {};

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

function clearGuardEnv(): void {
  for (const key of GUARD_KEYS) delete process.env[key];
}

beforeEach(() => {
  savedEnv = snapshotEnv();
  __resetSetupTestDbForTests();
  ensureDatabaseMock.mockClear();
});

afterEach(() => {
  restoreEnv(savedEnv);
});

describe("setupTestDb — D266 Wave 1 routing guard", () => {
  test("unset instance routes to scratch and reaches ensureDatabase (guard before DB)", async () => {
    clearGuardEnv();
    await setupTestDb();
    expect(process.env["NAUTILO_INSTANCE_ID"]).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    expect(ensureDatabaseMock).toHaveBeenCalledTimes(1);
  });

  test("scratch routing clears stale direct DB connection overrides before DB resolution", async () => {
    clearGuardEnv();
    process.env["NAUTILO_INSTANCE_ID"] = RECOMMENDED_SCRATCH_INSTANCE;
    process.env["DB_DIRECT_CONNECTION"] = "postgresql://postgres:postgres@localhost:5434/nautilo";
    process.env["DB_CONNECTION_STRING"] = "postgresql://postgres:postgres@localhost:5434/nautilo";
    process.env["NAUTILO_DB_PORT"] = "5434";
    await setupTestDb();
    expect(process.env["DB_DIRECT_CONNECTION"]).toBeUndefined();
    expect(process.env["DB_CONNECTION_STRING"]).toBeUndefined();
    expect(process.env["NAUTILO_DB_PORT"]).toBeUndefined();
    expect(ensureDatabaseMock).toHaveBeenCalledTimes(1);
  });

  test("arbitrary named instance is preserved through to DB resolution", async () => {
    clearGuardEnv();
    process.env["NAUTILO_INSTANCE_ID"] = "alpha";
    await setupTestDb();
    expect(process.env["NAUTILO_INSTANCE_ID"]).toBe("alpha");
    expect(ensureDatabaseMock).toHaveBeenCalledTimes(1);
  });

  test("explicit `default` is refused before ensureDatabase", () => {
    clearGuardEnv();
    process.env["NAUTILO_INSTANCE_ID"] = "default";
    expect(() => setupTestDb()).toThrow(DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE);
    expect(ensureDatabaseMock).not.toHaveBeenCalled();
  });

  test("`(default)` alias is refused before ensureDatabase", () => {
    clearGuardEnv();
    process.env["NAUTILO_INSTANCE_ID"] = "(default)";
    expect(() => setupTestDb()).toThrow(DEFAULT_DB_FIXTURE_REFUSAL_MESSAGE);
    expect(ensureDatabaseMock).not.toHaveBeenCalled();
  });

  test("ALLOW_DEFAULT_DB_TESTS=1 escape hatch reaches ensureDatabase", async () => {
    clearGuardEnv();
    process.env["NAUTILO_INSTANCE_ID"] = "default";
    process.env["ALLOW_DEFAULT_DB_TESTS"] = "1";
    await setupTestDb();
    expect(ensureDatabaseMock).toHaveBeenCalledTimes(1);
  });

  test("CI environment reaches ensureDatabase", async () => {
    clearGuardEnv();
    process.env["NAUTILO_INSTANCE_ID"] = "default";
    process.env["CI"] = "true";
    await setupTestDb();
    expect(ensureDatabaseMock).toHaveBeenCalledTimes(1);
  });

  test("idempotency latch short-circuits the guard on second call", async () => {
    clearGuardEnv();
    await setupTestDb();
    expect(ensureDatabaseMock).toHaveBeenCalledTimes(1);
    // Second call returns without re-invoking the guard or ensureDatabase.
    await setupTestDb();
    expect(ensureDatabaseMock).toHaveBeenCalledTimes(1);
  });
});

// Sanity: the guard helper itself remains the pure routing source of truth
// (no DB touched). This pins the contract the seam relies on.
describe("bootstrapTestDbInstance — pure routing contract", () => {
  test("unset routes to scratch and clears overrides without throwing", () => {
    clearGuardEnv();
    process.env["DB_CONNECTION_STRING"] = "postgresql://stale@localhost:5434/nautilo";
    const label = bootstrapTestDbInstance();
    expect(label).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    expect(process.env["NAUTILO_INSTANCE_ID"]).toBe(RECOMMENDED_SCRATCH_INSTANCE);
    expect(process.env["DB_CONNECTION_STRING"]).toBeUndefined();
  });
});
