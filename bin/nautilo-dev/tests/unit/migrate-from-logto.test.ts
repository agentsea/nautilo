/**
 * M053 — `runMigrateFromLogto` unit tests.
 */
import { describe, test, expect } from "bun:test";
import {
  runMigrateFromLogto,
  type MigrateFromLogtoArgs,
  type MigrateFromLogtoDeps,
} from "../../src/commands/migrate-from-logto";
import {
  makeFakeAdmin,
  makeFakeDb,
  recordingLogger,
  seedUser,
  type FakeAdminState,
  type FakeDbState,
} from "./logto-migration-helpers";

function makeHarness(): {
  dbState: FakeDbState;
  adminState: FakeAdminState;
  logger: ReturnType<typeof recordingLogger>;
  deps: MigrateFromLogtoDeps;
} {
  const dbState: FakeDbState = {
    users: new Map(),
    hasExternalIdColumn: true,
  };
  const adminState: FakeAdminState = { users: new Map(), calls: [] };
  const logger = recordingLogger();
  const deps: MigrateFromLogtoDeps = {
    db: makeFakeDb(dbState),
    getAdmin: () => makeFakeAdmin(adminState),
    logger,
  };
  return { dbState, adminState, logger, deps };
}

const NO_ARGS: MigrateFromLogtoArgs = {};

describe("runMigrateFromLogto", () => {
  test("returns 0 with a friendly message when no rows are linked", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    const code = await runMigrateFromLogto(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(
      h.logger.lines.some((l) => l.includes("No linked users to roll back")),
    ).toBe(true);
  });

  test("clears external_id on every linked local row", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice", externalId: "logto-1" });
    seedUser(h.dbState, { id: "u2", name: "Bob", externalId: "logto-2" });
    seedUser(h.dbState, { id: "u3", name: "Carol" }); // unlinked
    seedUser(h.dbState, {
      id: "stub",
      name: "Remote",
      server: "other.example.com",
      externalId: "ignored",
    });
    const code = await runMigrateFromLogto(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(h.dbState.users.get("u1")?.externalId).toBeNull();
    expect(h.dbState.users.get("u2")?.externalId).toBeNull();
    // Foreign-origin stub is untouched.
    expect(h.dbState.users.get("stub")?.externalId).toBe("ignored");
  });

  test("--dry-run makes zero DB writes AND zero Logto API calls", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice", externalId: "logto-1" });
    h.adminState.users.set("logto-1", {
      id: "logto-1",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    const code = await runMigrateFromLogto(
      { dryRun: true, deleteLogtoUsers: true },
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.dbState.users.get("u1")?.externalId).toBe("logto-1");
    // Critically: getAdmin() must NOT have been called in dry-run.
    expect(h.adminState.calls.length).toBe(0);
    expect(h.logger.tableRows.length).toBe(1);
  });

  test("--delete-logto-users calls deleteUser, NOT revokeUser", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice", externalId: "logto-1" });
    seedUser(h.dbState, { id: "u2", name: "Bob", externalId: "logto-2" });
    h.adminState.users.set("logto-1", {
      id: "logto-1",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    h.adminState.users.set("logto-2", {
      id: "logto-2",
      isSuspended: false,
      primaryEmail: "bob@example.com",
      username: "bob",
    });
    await runMigrateFromLogto({ deleteLogtoUsers: true }, h.deps);
    const deleteCalls = h.adminState.calls.filter(
      (c) => c.method === "deleteUser",
    );
    expect(deleteCalls.length).toBe(2);
    expect(deleteCalls[0]!.args).toEqual(["logto-1"]);
    expect(deleteCalls[1]!.args).toEqual(["logto-2"]);
    // No revoke (suspend) call ever.
    expect(
      h.adminState.calls.find((c) => c.method === "revokeUser"),
    ).toBeUndefined();
    // Logto state is empty after deletes.
    expect(h.adminState.users.size).toBe(0);
  });

  test("default (no --delete-logto-users) leaves Logto users in place", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice", externalId: "logto-1" });
    h.adminState.users.set("logto-1", {
      id: "logto-1",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    await runMigrateFromLogto(NO_ARGS, h.deps);
    expect(h.dbState.users.get("u1")?.externalId).toBeNull();
    expect(h.adminState.users.get("logto-1")).toBeDefined();
    expect(h.adminState.calls.length).toBe(0);
  });

  test("captures externalIds before clearing — deletion uses pre-clear values", async () => {
    // Guards against the bug where you re-select rows after the UPDATE
    // and find empty external_id values (loop deletes nothing).
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice", externalId: "logto-1" });
    h.adminState.users.set("logto-1", {
      id: "logto-1",
      isSuspended: false,
      primaryEmail: null,
      username: null,
    });
    await runMigrateFromLogto({ deleteLogtoUsers: true }, h.deps);
    expect(h.adminState.users.size).toBe(0);
  });
});
