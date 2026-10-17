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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanupTestCruft,
  type CleanupTestCruftArgs,
} from "../../src/commands/cleanup-test-cruft";

const DEFAULT_ENV = { NAUTILO_INSTANCE_ID: "default" } as NodeJS.ProcessEnv;
const CONFIG_SENTINEL_KEY = "NAUTILO_CLEANUP_TEST_CONFIG_SENTINEL";

/** Valid UUIDv4 shape used to assert the format check passes the parse gate. */
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("cleanup-test-cruft --allow-fixture-user-ids (pre-DB validation)", () => {
  let errCapture: string[];
  let stdoutCapture: string[];
  let fixtureRoot: string;
  let absentConfigEnvPath: string;
  const origErr = console.error;
  const origLog = console.log;

  function fixtureArgs(
    args: Omit<CleanupTestCruftArgs, "cwd" | "env" | "configEnvPath">,
  ): CleanupTestCruftArgs {
    return {
      ...args,
      cwd: fixtureRoot,
      env: DEFAULT_ENV,
      configEnvPath: absentConfigEnvPath,
    };
  }

  beforeEach(() => {
    // Synthetic nautilo-* worktree — do not derive from repo root. The absent
    // config path prevents a unit test from loading the operator's real
    // selected instance.env into process.env.
    fixtureRoot = mkdtempSync(join(tmpdir(), "nautilo-cleanup-explicit-ids-"));
    absentConfigEnvPath = join(fixtureRoot, "absent-instance.env");
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
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("rejects invalid UUIDs before touching the DB", async () => {
    const code = await cleanupTestCruft(fixtureArgs({
      keepUserHandles: "operator",
      allowFixtureUserIds: "not-a-uuid,also-bad",
    }));
    expect(code).toBe(1);
    expect(errCapture.join("\n")).toContain(
      "invalid UUID(s) in --allow-fixture-user-ids: not-a-uuid, also-bad",
    );
    expect(errCapture.join("\n")).toContain("no prefixes / wildcards");
  });

  test("rejects prefix / wildcard shaped tokens (UUID shape gate)", async () => {
    const code = await cleanupTestCruft(fixtureArgs({
      keepUserHandles: "operator",
      allowFixtureUserIds: "d386-*",
    }));
    expect(code).toBe(1);
    expect(errCapture.join("\n")).toContain("invalid UUID(s) in --allow-fixture-user-ids: d386-*");
  });

  test("plan-json keeps malformed-input errors off stdout before DB access", async () => {
    const code = await cleanupTestCruft(fixtureArgs({
      keepUserHandles: "operator",
      allowFixtureUserIds: "not-a-uuid",
      planJson: true,
    }));
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    expect(errCapture.join("\n")).toContain(
      "invalid UUID(s) in --allow-fixture-user-ids: not-a-uuid",
    );
  });

  test("still requires a keep-set when explicit IDs are supplied", async () => {
    const code = await cleanupTestCruft(fixtureArgs({
      // no keepUserHandles / keepUserIds
      allowFixtureUserIds: VALID_UUID,
    }));
    expect(code).toBe(1);
    expect(errCapture.join("\n")).toContain(
      "provide at least one of --keep-user-handles",
    );
  });

  test("--allow-half-redeemed-fixtures is a DEPRECATED no-op and does not bypass validation", async () => {
    const code = await cleanupTestCruft(fixtureArgs({
      keepUserHandles: "operator",
      allowHalfRedeemedFixtures: true,
      allowFixtureUserIds: "not-a-uuid",
    }));
    // The deprecation flag must NOT authorize deletion or bypass the
    // explicit-ID UUID validation — the run still refuses on the bad UUID.
    expect(code).toBe(1);
    const combined = errCapture.join("\n");
    expect(combined).toContain("DEPRECATED: --allow-half-redeemed-fixtures is a no-op");
    expect(combined).toContain("no longer authorizes deletion");
    expect(combined).toContain("invalid UUID(s) in --allow-fixture-user-ids: not-a-uuid");
  });

  test("does not load the process-default config path", async () => {
    const decoyConfigEnvPath = join(fixtureRoot, "process-default-instance.env");
    const previousOverride = process.env["NAUTILO_DOTENV_PATH"];
    const previousSentinel = process.env[CONFIG_SENTINEL_KEY];
    writeFileSync(decoyConfigEnvPath, `${CONFIG_SENTINEL_KEY}=loaded\n`);
    process.env["NAUTILO_DOTENV_PATH"] = decoyConfigEnvPath;
    delete process.env[CONFIG_SENTINEL_KEY];

    try {
      expect(existsSync(absentConfigEnvPath)).toBe(false);
      await cleanupTestCruft(fixtureArgs({
        keepUserHandles: "operator",
        allowFixtureUserIds: "not-a-uuid",
      }));
      expect(process.env[CONFIG_SENTINEL_KEY]).toBeUndefined();
    } finally {
      if (previousOverride === undefined) delete process.env["NAUTILO_DOTENV_PATH"];
      else process.env["NAUTILO_DOTENV_PATH"] = previousOverride;
      if (previousSentinel === undefined) delete process.env[CONFIG_SENTINEL_KEY];
      else process.env[CONFIG_SENTINEL_KEY] = previousSentinel;
    }
  });
});
