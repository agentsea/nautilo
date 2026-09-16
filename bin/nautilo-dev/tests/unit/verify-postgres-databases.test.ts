/**
 * M051: probe + fix logic for `nautilo-dev verify-postgres-databases`.
 *
 * The actual docker / psql calls are abstracted behind `ClusterExec` so
 * the test can exercise every state without a real Postgres or container.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import {
  applyFix,
  probe,
  verifyPostgresDatabases,
  type ClusterExec,
  type ProbeResult,
} from "../../src/commands/verify-postgres-databases";

let tmpHome: string;
let prevHome: string | undefined;
let prevInstanceId: string | undefined;

beforeEach(() => {
  __resetResolvedInstanceForTests();
  prevHome = process.env["HOME"];
  prevInstanceId = process.env["NAUTILO_INSTANCE_ID"];
  delete process.env["NAUTILO_INSTANCE_ID"];
  tmpHome = mkdtempSync(join(tmpdir(), "nautilo-vpg-"));
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  __resetResolvedInstanceForTests();
  if (prevHome !== undefined) process.env["HOME"] = prevHome;
  else delete process.env["HOME"];
  if (prevInstanceId === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
  else process.env["NAUTILO_INSTANCE_ID"] = prevInstanceId;
  rmSync(tmpHome, { recursive: true, force: true });
});

interface FakeState {
  containerRunning: boolean;
  dbPresent: boolean;
  rolePresent: boolean;
  /** Records every SQL statement in execution order. Inspect in tests. */
  log: string[];
}

function makeFakeExec(state: FakeState): ClusterExec {
  return {
    containerRunning: () => state.containerRunning,
    query: (sql) => {
      state.log.push(sql);
      // Probe queries return "1" iff the corresponding object exists.
      if (sql.includes("FROM pg_database WHERE datname='logto_nautilo'")) {
        return state.dbPresent ? "1" : "";
      }
      if (sql.includes("FROM pg_roles WHERE rolname='logto'")) {
        return state.rolePresent ? "1" : "";
      }
      // Mutating statements: simulate the side effect so re-probe sees it.
      if (/^CREATE ROLE logto LOGIN CREATEROLE/i.test(sql)) {
        state.rolePresent = true;
        return "";
      }
      if (/^CREATE DATABASE logto_nautilo /i.test(sql)) {
        state.dbPresent = true;
        return "";
      }
      return "";
    },
  };
}

describe("probe", () => {
  test("returns no-container when container is down", () => {
    const state: FakeState = {
      containerRunning: false,
      dbPresent: false,
      rolePresent: false,
      log: [],
    };
    const result = probe(makeFakeExec(state), "nautilo-postgres", "postgres");
    expect(result.status).toBe("no-container");
    expect(state.log).toEqual([]); // no SQL issued when container is down
  });

  test("returns ok when both DB and role present", () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: true,
      rolePresent: true,
      log: [],
    };
    const result = probe(makeFakeExec(state), "nautilo-postgres", "postgres");
    expect(result.status).toBe("ok");
    expect(result.dbPresent).toBe(true);
    expect(result.rolePresent).toBe(true);
  });

  test("returns missing-db when DB absent but role present", () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: false,
      rolePresent: true,
      log: [],
    };
    const result = probe(makeFakeExec(state), "nautilo-postgres", "postgres");
    expect(result.status).toBe("missing-db");
  });

  test("returns missing-role when role absent but DB present", () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: true,
      rolePresent: false,
      log: [],
    };
    const result = probe(makeFakeExec(state), "nautilo-postgres", "postgres");
    expect(result.status).toBe("missing-role");
  });

  test("returns missing-both on a fresh pre-M051 cluster", () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: false,
      rolePresent: false,
      log: [],
    };
    const result = probe(makeFakeExec(state), "nautilo-postgres", "postgres");
    expect(result.status).toBe("missing-both");
  });
});

describe("applyFix", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env["LOGTO_DB_PASSWORD"];
    delete process.env["LOGTO_DB_PASSWORD"];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env["LOGTO_DB_PASSWORD"];
    else process.env["LOGTO_DB_PASSWORD"] = originalEnv;
  });

  test("missing-both → CREATE ROLE + CREATE DATABASE + grants", () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: false,
      rolePresent: false,
      log: [],
    };
    const result: ProbeResult = {
      status: "missing-both",
      dbPresent: false,
      rolePresent: false,
      containerRunning: true,
    };
    const { generatedPassword } = applyFix(
      makeFakeExec(state),
      "nautilo-postgres",
      "postgres",
      result,
    );
    expect(generatedPassword).not.toBeNull();
    expect(generatedPassword!.length).toBeGreaterThan(20);
    expect(state.log.some((s) => s.startsWith("CREATE ROLE logto"))).toBe(true);
    expect(state.log.some((s) => s.startsWith("CREATE DATABASE logto_nautilo"))).toBe(
      true,
    );
    // PUBLIC keeps default CONNECT on logto_nautilo (see code comment);
    // we only assert the GRANT here, not a REVOKE.
    expect(state.log.some((s) => s.includes("GRANT ALL"))).toBe(true);
  });

  test("missing-db only → no CREATE ROLE, but CREATE DATABASE + grants", () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: false,
      rolePresent: true,
      log: [],
    };
    applyFix(
      makeFakeExec(state),
      "nautilo-postgres",
      "postgres",
      {
        status: "missing-db",
        dbPresent: false,
        rolePresent: true,
        containerRunning: true,
      },
    );
    expect(state.log.some((s) => s.startsWith("CREATE ROLE logto"))).toBe(false);
    expect(state.log.some((s) => s.startsWith("CREATE DATABASE logto_nautilo"))).toBe(
      true,
    );
  });

  test("uses LOGTO_DB_PASSWORD from env when set (no generation)", () => {
    process.env["LOGTO_DB_PASSWORD"] = "from-env-password";
    const state: FakeState = {
      containerRunning: true,
      dbPresent: false,
      rolePresent: false,
      log: [],
    };
    const { generatedPassword } = applyFix(
      makeFakeExec(state),
      "nautilo-postgres",
      "postgres",
      {
        status: "missing-both",
        dbPresent: false,
        rolePresent: false,
        containerRunning: true,
      },
    );
    expect(generatedPassword).toBeNull();
    expect(
      state.log.some((s) => s.includes("from-env-password")),
    ).toBe(true);
  });
});

describe("verifyPostgresDatabases (CLI entry)", () => {
  test("ok cluster → exit 0 without --fix", async () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: true,
      rolePresent: true,
      log: [],
    };
    const messages: string[] = [];
    const code = await verifyPostgresDatabases({}, makeFakeExec(state), (m) =>
      messages.push(m),
    );
    expect(code).toBe(0);
    expect(messages.some((m) => m.includes("OK"))).toBe(true);
  });

  test("missing-db without --fix → exit 1, prints manual SQL hint", async () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: false,
      rolePresent: true,
      log: [],
    };
    const messages: string[] = [];
    const code = await verifyPostgresDatabases({}, makeFakeExec(state), (m) =>
      messages.push(m),
    );
    expect(code).toBe(1);
    expect(messages.some((m) => m.includes("CREATE DATABASE logto_nautilo"))).toBe(
      true,
    );
    // No CREATE ROLE hint when role already exists.
    expect(messages.some((m) => m.includes("CREATE ROLE logto"))).toBe(false);
  });

  test("missing-both with --fix → exit 0, applies, re-probes ok", async () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: false,
      rolePresent: false,
      log: [],
    };
    const messages: string[] = [];
    const code = await verifyPostgresDatabases(
      { fix: true },
      makeFakeExec(state),
      (m) => messages.push(m),
    );
    expect(code).toBe(0);
    expect(state.dbPresent).toBe(true);
    expect(state.rolePresent).toBe(true);
    expect(messages.some((m) => m.includes("repair applied"))).toBe(true);
  });

  test("--fix on already-ok cluster is idempotent (no fix path runs)", async () => {
    const state: FakeState = {
      containerRunning: true,
      dbPresent: true,
      rolePresent: true,
      log: [],
    };
    const code = await verifyPostgresDatabases(
      { fix: true },
      makeFakeExec(state),
      () => {},
    );
    expect(code).toBe(0);
    // Only the two probe queries; no CREATE/REVOKE/GRANT statements.
    expect(state.log.length).toBe(2);
    expect(state.log.every((s) => s.startsWith("SELECT 1"))).toBe(true);
  });

  test("no-container exits 1 with hint", async () => {
    const state: FakeState = {
      containerRunning: false,
      dbPresent: false,
      rolePresent: false,
      log: [],
    };
    const messages: string[] = [];
    const code = await verifyPostgresDatabases({}, makeFakeExec(state), (m) =>
      messages.push(m),
    );
    expect(code).toBe(1);
    expect(messages.some((m) => m.includes("not running"))).toBe(true);
  });
});
