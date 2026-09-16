/**
 * M107 — `runMigrateToUsernameIdentity` unit tests (injected fakes; no Postgres).
 */
import { describe, test, expect } from "bun:test";
import { LOGTO_REQUIRED_KEYS } from "@nautilo/config-guard";
import { SIGN_IN_EXP_USERNAME_PATCH_BODY } from "@nautilo/local/bootstrap-logto";
import {
  SIGN_IN_EXP_EMAIL_PATCH_BODY,
  runMigrateToUsernameIdentity,
  type MigrateToUsernameIdentityArgs,
  type MigrateToUsernameIdentityDeps,
} from "../../src/commands/migrate-to-username-identity";
import {
  makeFakeAdmin,
  makeFakeDb,
  recordingLogger,
  seedUser,
  type FakeAdminState,
  type FakeDbState,
} from "./logto-migration-helpers";

function fullEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of LOGTO_REQUIRED_KEYS) env[k] = `value-of-${k}`;
  return env;
}

interface Harness {
  dbState: FakeDbState;
  adminState: FakeAdminState;
  logger: ReturnType<typeof recordingLogger>;
  fetchCalls: string[];
  /** Counts `deleteLogtoOneTimeTokens` invocations. */
  deleteTokenCalls: number;
  /** Bodies passed to `patchDefaultTenantSignInExp`. */
  sieBodies: unknown[];
  deps: MigrateToUsernameIdentityDeps;
}

function makeHarness(opts: { fetchOk?: boolean } = {}): Harness {
  const dbState: FakeDbState = {
    users: new Map(),
    hasExternalIdColumn: true,
  };
  const adminState: FakeAdminState = {
    users: new Map(),
    calls: [],
  };
  const logger = recordingLogger();
  const fetchCalls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    fetchCalls.push(String(url));
    if (opts.fetchOk === false) {
      return new Response("offline", { status: 503 });
    }
    return new Response(JSON.stringify({ issuer: "logto" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const side = { deleteTokenCalls: 0, sieBodies: [] as unknown[] };

  const deps: MigrateToUsernameIdentityDeps = {
    db: makeFakeDb(dbState),
    admin: makeFakeAdmin(adminState),
    logger,
    env: fullEnv(),
    fetchImpl,
    deleteLogtoOneTimeTokens: async () => {
      side.deleteTokenCalls++;
    },
    patchDefaultTenantSignInExp: async (body) => {
      side.sieBodies.push(body);
    },
  };

  return {
    dbState,
    adminState,
    logger,
    fetchCalls,
    get deleteTokenCalls() {
      return side.deleteTokenCalls;
    },
    get sieBodies() {
      return side.sieBodies;
    },
    deps,
  };
}

const NO_ARGS: MigrateToUsernameIdentityArgs = {};

describe("runMigrateToUsernameIdentity — dry-run", () => {
  test("three-user fixture: ok / set-username / set-username-from-email", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u-has",
      name: "Has",
      externalId: "logto-a",
      handle: "ignored",
    });
    seedUser(h.dbState, {
      id: "u-handle",
      name: "Handle",
      externalId: "logto-b",
      handle: "MyHandle",
    });
    seedUser(h.dbState, {
      id: "u-mail",
      name: "Mail",
      externalId: "logto-c",
      handle: null,
      email: "who@cares.com",
    });
    h.adminState.users.set("logto-a", {
      id: "logto-a",
      isSuspended: false,
      primaryEmail: "a@x.com",
      username: "already",
    });
    h.adminState.users.set("logto-b", {
      id: "logto-b",
      isSuspended: false,
      primaryEmail: "b@x.com",
      username: null,
    });
    h.adminState.users.set("logto-c", {
      id: "logto-c",
      isSuspended: false,
      primaryEmail: "Only.Email@Example.com",
      username: null,
    });

    const code = await runMigrateToUsernameIdentity(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(h.logger.tableRows.length).toBe(1);
    const rows = h.logger.tableRows[0]!;
    expect(rows.length).toBe(3);
    const byId = new Map(rows.map((r) => [String(r["user_id"]), r]));
    expect(byId.get("u-has")!["action"]).toBe("ok");
    expect(byId.get("u-has")!["proposed_username"]).toBe("already");
    expect(byId.get("u-handle")!["action"]).toBe("set-username");
    expect(byId.get("u-handle")!["proposed_username"]).toBe("myhandle");
    expect(byId.get("u-mail")!["action"]).toBe("set-username");
    expect(byId.get("u-mail")!["proposed_username"]).toBe("only.email");
    expect(
      h.logger.lines.some((l) =>
        l.includes("deriving username") && l.includes("u-mail"),
      ),
    ).toBe(true);
    expect(h.adminState.calls.filter((c) => c.method === "patchUser")).toHaveLength(
      0,
    );
  });
});

describe("runMigrateToUsernameIdentity — --apply", () => {
  test("happy path: PATCH order, handle backfill, DELETE tokens, username SIE", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "One",
      externalId: "lt-1",
      handle: "alpha",
    });
    seedUser(h.dbState, {
      id: "u2",
      name: "Two",
      externalId: "lt-2",
      handle: null,
    });
    h.adminState.users.set("lt-1", {
      id: "lt-1",
      isSuspended: false,
      primaryEmail: "a@x.com",
      username: null,
    });
    h.adminState.users.set("lt-2", {
      id: "lt-2",
      isSuspended: false,
      primaryEmail: "beta.user@x.com",
      username: null,
    });

    const code = await runMigrateToUsernameIdentity({ apply: true }, h.deps);
    expect(code).toBe(0);

    const patches = h.adminState.calls.filter((c) => c.method === "patchUser");
    expect(patches.map((c) => c.args[0])).toEqual(["lt-1", "lt-2"]);
    expect(patches[0]!.args[1]).toEqual({ username: "alpha" });
    expect(patches[1]!.args[1]).toEqual({ username: "beta.user" });

    expect(h.dbState.handleBackfills).toEqual([{ userId: "u2", handle: "beta.user" }]);
    expect(h.deleteTokenCalls).toBe(1);
    expect(h.sieBodies).toEqual([SIGN_IN_EXP_USERNAME_PATCH_BODY]);
  });

  test("handle collision pre-flight aborts before PATCH / DELETE / SIE", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "a",
      name: "A",
      externalId: "lt-a",
      handle: "Same",
    });
    seedUser(h.dbState, {
      id: "b",
      name: "B",
      externalId: "lt-b",
      handle: "same",
    });
    h.adminState.users.set("lt-a", {
      id: "lt-a",
      isSuspended: false,
      primaryEmail: "a@x.com",
      username: null,
    });
    h.adminState.users.set("lt-b", {
      id: "lt-b",
      isSuspended: false,
      primaryEmail: "b@x.com",
      username: null,
    });

    const code = await runMigrateToUsernameIdentity({ apply: true }, h.deps);
    expect(code).toBe(1);
    expect(h.adminState.calls.some((c) => c.method === "patchUser")).toBe(false);
    expect(h.deleteTokenCalls).toBe(0);
    expect(h.sieBodies).toEqual([]);
  });

  test("Logto 409 on PATCH aborts before SIE; logs Nautilo user id", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u409",
      name: "X",
      externalId: "lt-x",
      handle: "xuser",
    });
    h.adminState.users.set("lt-x", {
      id: "lt-x",
      isSuspended: false,
      primaryEmail: "x@x.com",
      username: null,
    });
    h.adminState.patchUserStatusByUserId = new Map([["lt-x", 409]]);

    const code = await runMigrateToUsernameIdentity({ apply: true }, h.deps);
    expect(code).toBe(1);
    expect(
      h.logger.lines.some(
        (l) => l.includes("409") && l.includes("user_id=u409"),
      ),
    ).toBe(true);
    expect(h.sieBodies).toEqual([]);
    expect(h.deleteTokenCalls).toBe(0);
  });

  test("second --apply issues no user PATCH when everyone already has Logto username", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "One",
      externalId: "lt-1",
      handle: "alpha",
    });
    h.adminState.users.set("lt-1", {
      id: "lt-1",
      isSuspended: false,
      primaryEmail: "a@x.com",
      username: null,
    });

    expect(await runMigrateToUsernameIdentity({ apply: true }, h.deps)).toBe(0);
    expect(
      h.adminState.calls.filter((c) => c.method === "patchUser"),
    ).toHaveLength(1);

    h.adminState.calls.length = 0;
    h.dbState.handleBackfills = [];

    expect(await runMigrateToUsernameIdentity({ apply: true }, h.deps)).toBe(0);
    expect(
      h.adminState.calls.filter((c) => c.method === "patchUser"),
    ).toHaveLength(0);
    expect(h.dbState.handleBackfills ?? []).toEqual([]);
    expect(h.deleteTokenCalls).toBe(2);
    expect(h.sieBodies).toEqual([
      SIGN_IN_EXP_USERNAME_PATCH_BODY,
      SIGN_IN_EXP_USERNAME_PATCH_BODY,
    ]);
  });
});

describe("runMigrateToUsernameIdentity — --rollback", () => {
  test("PATCHes email-mode SIE only; no user PATCH or token delete", async () => {
    const h = makeHarness();
    const code = await runMigrateToUsernameIdentity({ rollback: true }, h.deps);
    expect(code).toBe(0);
    expect(h.sieBodies).toEqual([SIGN_IN_EXP_EMAIL_PATCH_BODY]);
    expect(h.adminState.calls.filter((c) => c.method === "patchUser")).toHaveLength(
      0,
    );
    expect(h.deleteTokenCalls).toBe(0);
  });

  test("--apply and --rollback together is rejected", async () => {
    const h = makeHarness();
    const code = await runMigrateToUsernameIdentity(
      { apply: true, rollback: true },
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.sieBodies).toEqual([]);
  });
});
