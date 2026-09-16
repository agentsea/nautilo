/**
 * M053 — `runVerifyUserLink` unit tests.
 */
import { describe, test, expect } from "bun:test";
import {
  runVerifyUserLink,
  type VerifyUserLinkDeps,
} from "../../src/commands/verify-user-link";
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
  deps: VerifyUserLinkDeps;
} {
  const dbState: FakeDbState = {
    users: new Map(),
    hasExternalIdColumn: true,
  };
  const adminState: FakeAdminState = { users: new Map(), calls: [] };
  const logger = recordingLogger();
  const deps: VerifyUserLinkDeps = {
    db: makeFakeDb(dbState),
    admin: makeFakeAdmin(adminState),
    logger,
  };
  return { dbState, adminState, logger, deps };
}

describe("runVerifyUserLink", () => {
  test("returns 'linked' (exit 0) when external_id matches an active Logto user", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
      externalId: "logto-1",
    });
    h.adminState.users.set("logto-1", {
      id: "logto-1",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    const result = await runVerifyUserLink(
      { email: "alice@example.com" },
      h.deps,
    );
    expect(result.status).toBe("linked");
    expect(result.exitCode).toBe(0);
    // Used getUser (fast path), NOT findUserByEmailOrUsername.
    expect(
      h.adminState.calls.find((c) => c.method === "getUser"),
    ).toBeDefined();
    expect(
      h.adminState.calls.find(
        (c) => c.method === "findUserByEmailOrUsername",
      ),
    ).toBeUndefined();
  });

  test("returns 'linked-suspended' (exit 1) when Logto user is suspended", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
      externalId: "logto-1",
    });
    h.adminState.users.set("logto-1", {
      id: "logto-1",
      isSuspended: true,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    const result = await runVerifyUserLink(
      { email: "alice@example.com" },
      h.deps,
    );
    expect(result.status).toBe("linked-suspended");
    expect(result.exitCode).toBe(1);
  });

  test("returns 'unlinked-no-logto' for the typical pre-migration state", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
    });
    const result = await runVerifyUserLink(
      { email: "alice@example.com" },
      h.deps,
    );
    expect(result.status).toBe("unlinked-no-logto");
    expect(result.exitCode).toBe(1);
    // Used findUserByEmailOrUsername (slow path) when external_id is NULL.
    expect(
      h.adminState.calls.find(
        (c) => c.method === "findUserByEmailOrUsername",
      ),
    ).toBeDefined();
  });

  test("returns 'unlinked-orphan-logto' when Logto account exists but DB external_id is NULL", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
    });
    h.adminState.users.set("logto-orphan", {
      id: "logto-orphan",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    const result = await runVerifyUserLink(
      { email: "alice@example.com" },
      h.deps,
    );
    expect(result.status).toBe("unlinked-orphan-logto");
    expect(result.exitCode).toBe(1);
  });

  test("returns 'linked-but-logto-missing' when external_id is set but Logto says 404", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
      externalId: "logto-gone",
    });
    // No entry in adminState.users → getUser returns null.
    const result = await runVerifyUserLink(
      { email: "alice@example.com" },
      h.deps,
    );
    expect(result.status).toBe("linked-but-logto-missing");
    expect(result.exitCode).toBe(1);
  });

  test("returns 'user-not-found' (exit 2) when --email isn't in the DB", async () => {
    const h = makeHarness();
    const result = await runVerifyUserLink(
      { email: "nobody@example.com" },
      h.deps,
    );
    expect(result.status).toBe("user-not-found");
    expect(result.exitCode).toBe(2);
  });

  test("returns 'user-not-found' (exit 2) when --email is missing", async () => {
    const h = makeHarness();
    const result = await runVerifyUserLink({}, h.deps);
    expect(result.status).toBe("user-not-found");
    expect(result.exitCode).toBe(2);
    expect(h.logger.lines.join("\n")).toContain("Missing required flag");
  });
});
