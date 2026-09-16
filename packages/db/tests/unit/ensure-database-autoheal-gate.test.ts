/**
 * ISSUE-D202 — the scratch auto-heal gate must NEVER fire against the
 * protected `(default)` instance or any named instance. Pure function;
 * no DB connection.
 */
import { describe, expect, test } from "bun:test";
import { shouldAutoHealScratchDb } from "../../src/utils/ensure-database";
import {
  RECOMMENDED_SCRATCH_INSTANCE,
  TEST_DB_AUTOHEAL_ENV,
} from "../../src/testing/instance-guard";

describe("shouldAutoHealScratchDb — destructive-heal gate", () => {
  test("scratch instance with autoheal flag → true", () => {
    expect(
      shouldAutoHealScratchDb({
        [TEST_DB_AUTOHEAL_ENV]: "1",
        NAUTILO_INSTANCE_ID: RECOMMENDED_SCRATCH_INSTANCE,
      }),
    ).toBe(true);
  });

  test("scratch autoheal with stale DB connection override → false", () => {
    expect(
      shouldAutoHealScratchDb({
        [TEST_DB_AUTOHEAL_ENV]: "1",
        NAUTILO_INSTANCE_ID: RECOMMENDED_SCRATCH_INSTANCE,
        DB_DIRECT_CONNECTION: "postgresql://postgres:postgres@localhost:5434/nautilo",
      }),
    ).toBe(false);
    expect(
      shouldAutoHealScratchDb({
        [TEST_DB_AUTOHEAL_ENV]: "1",
        NAUTILO_INSTANCE_ID: RECOMMENDED_SCRATCH_INSTANCE,
        NAUTILO_DB_PORT: "5434",
      }),
    ).toBe(false);
  });

  test("default instance (empty) with flag → false (never auto-nuke default)", () => {
    expect(
      shouldAutoHealScratchDb({ [TEST_DB_AUTOHEAL_ENV]: "1", NAUTILO_INSTANCE_ID: "" }),
    ).toBe(false);
    expect(shouldAutoHealScratchDb({ [TEST_DB_AUTOHEAL_ENV]: "1" })).toBe(false);
  });

  test("named instance with flag → false (never auto-nuke a named instance)", () => {
    expect(
      shouldAutoHealScratchDb({ [TEST_DB_AUTOHEAL_ENV]: "1", NAUTILO_INSTANCE_ID: "alpha" }),
    ).toBe(false);
  });

  test("scratch instance WITHOUT the flag → false (prod/dev-stack untouched)", () => {
    expect(
      shouldAutoHealScratchDb({ NAUTILO_INSTANCE_ID: RECOMMENDED_SCRATCH_INSTANCE }),
    ).toBe(false);
  });
});
