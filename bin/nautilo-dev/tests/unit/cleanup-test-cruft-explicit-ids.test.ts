/**
 * D266 Wave 2 — unit tests for the `--allow-fixture-user-ids` override path
 * and the `--allow-half-redeemed-fixtures` deprecation no-op.
 *
 * Only the pre-DB validation seams are exercisable without a live Postgres
 * (invalid-UUID rejection and the keep-set requirement, both of which run
 * before `createDirectDb`). Missing-ID, noncandidate, and half-redeemed
 * dry-run assertions require a DB and are out of scope for this pure unit
 * test — they are covered by the Wave 2.4 read-only dry-run artifact.
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTestCruft } from "../../src/commands/cleanup-test-cruft";

/** Synthetic nautilo-* worktree — do not derive from repo root. */
const FEATURE_WORKTREE_CWD = join(tmpdir(), "nautilo-d266-explicit-ids");
mkdirSync(FEATURE_WORKTREE_CWD, { recursive: true });

const DEFAULT_ENV = { NAUTILO_INSTANCE_ID: "default" } as NodeJS.ProcessEnv;

/** Valid UUIDv4 shape used to assert the format check passes the parse gate. */
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("cleanup-test-cruft --allow-fixture-user-ids (pre-DB validation)", () => {
  let errCapture: string[];
  let stdoutCapture: string[];
  const origErr = console.error;
  const origLog = console.log;

  beforeEach(() => {
    errCapture = [];
    stdoutCapture = [];
    console.error = (...xs: unknown[]) => {
      errCapture.push(xs.join(" "));
    };
    console.log = (...xs: unknown[]) => {
      stdoutCapture.push(xs.join(" "));
    };
  });
  afterEach(() => {
    console.error = origErr;
    console.log = origLog;
  });

  test("rejects invalid UUIDs before touching the DB", async () => {
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      allowFixtureUserIds: "not-a-uuid,also-bad",
      cwd: FEATURE_WORKTREE_CWD,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(errCapture.join("\n")).toContain(
      "invalid UUID(s) in --allow-fixture-user-ids: not-a-uuid, also-bad",
    );
    expect(errCapture.join("\n")).toContain("no prefixes / wildcards");
  });

  test("rejects prefix / wildcard shaped tokens (UUID shape gate)", async () => {
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      allowFixtureUserIds: "d386-*",
      cwd: FEATURE_WORKTREE_CWD,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(errCapture.join("\n")).toContain("invalid UUID(s) in --allow-fixture-user-ids: d386-*");
  });

  test("plan-json keeps malformed-input errors off stdout before DB access", async () => {
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      allowFixtureUserIds: "not-a-uuid",
      planJson: true,
      cwd: FEATURE_WORKTREE_CWD,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    expect(errCapture.join("\n")).toContain(
      "invalid UUID(s) in --allow-fixture-user-ids: not-a-uuid",
    );
  });

  test("still requires a keep-set when explicit IDs are supplied", async () => {
    const code = await cleanupTestCruft({
      // no keepUserHandles / keepUserIds
      allowFixtureUserIds: VALID_UUID,
      cwd: FEATURE_WORKTREE_CWD,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(errCapture.join("\n")).toContain(
      "provide at least one of --keep-user-handles",
    );
  });

  test("--allow-half-redeemed-fixtures is a DEPRECATED no-op and does not bypass validation", async () => {
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      allowHalfRedeemedFixtures: true,
      allowFixtureUserIds: "not-a-uuid",
      cwd: FEATURE_WORKTREE_CWD,
      env: DEFAULT_ENV,
    });
    // The deprecation flag must NOT authorize deletion or bypass the
    // explicit-ID UUID validation — the run still refuses on the bad UUID.
    expect(code).toBe(1);
    const combined = errCapture.join("\n");
    expect(combined).toContain("DEPRECATED: --allow-half-redeemed-fixtures is a no-op");
    expect(combined).toContain("no longer authorizes deletion");
    expect(combined).toContain("invalid UUID(s) in --allow-fixture-user-ids: not-a-uuid");
  });
});
