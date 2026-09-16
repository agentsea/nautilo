/**
 * D104 Phase 3 — reset-logto-user-password runner tests.
 */
import { describe, test, expect } from "bun:test";
import {
  runResetLogtoUserPassword,
  formatPasswordResetFile,
  ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT,
} from "../../src/commands/reset-logto-user-password";
import type { LogtoUser } from "../../src/lib/logto-migration";
import {
  makeFakeDb,
  makeFakeAdmin,
  recordingLogger,
  seedUser,
} from "./logto-migration-helpers";

describe("formatPasswordResetFile", () => {
  test("includes metadata and password line", () => {
    const body = formatPasswordResetFile({
      nautiloUserId: "u-1",
      logtoSub: "logto-sub",
      email: "a@b.com",
      handle: "alice",
      temporaryPassword: "secrethex",
      isoStamp: "2026-01-01T00:00:00.000Z",
    });
    expect(body).toContain("Nautilo user id: u-1");
    expect(body).toContain("Logto sub: logto-sub");
    expect(body).toContain("temporary_password:");
    expect(body).toContain("secrethex");
  });
});

describe("runResetLogtoUserPassword", () => {
  test("exit 2 when neither --dry-run nor --yes", async () => {
    const db = makeFakeDb({
      users: new Map(),
      hasExternalIdColumn: true,
    });
    const admin = makeFakeAdmin({ users: new Map(), calls: [] });
    const log = recordingLogger();
    const code = await runResetLogtoUserPassword(
      { email: "x@y.com" },
      { db, admin, logger: log },
    );
    expect(code).toBe(2);
    expect(log.lines.some((l) => l.includes("--dry-run"))).toBe(true);
  });

  test("dry-run succeeds for linked user", async () => {
    const dbState = {
      users: new Map(),
      hasExternalIdColumn: true,
      hasLogtoAccountSecurityTable: true,
    };
    seedUser(dbState, {
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
      externalId: "logto-sub-1",
    });
    const db = makeFakeDb(dbState);
    const adminState = {
      users: new Map<string, LogtoUser>(),
      calls: [] as Array<{ method: string; args: unknown[] }>,
    };
    adminState.users.set("logto-sub-1", {
      id: "logto-sub-1",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    const admin = makeFakeAdmin(adminState);
    const log = recordingLogger();
    const code = await runResetLogtoUserPassword(
      { email: "alice@example.com", dryRun: true },
      { db, admin, logger: log },
    );
    expect(code).toBe(0);
    expect(log.lines.some((l) => l.includes("outcome=dry_run"))).toBe(true);
    expect(adminState.calls.filter((c) => c.method === "setUserPassword")).toHaveLength(0);
  });

  test("refuses ambiguous email (two local users)", async () => {
    const dbState = { users: new Map(), hasExternalIdColumn: true };
    seedUser(dbState, {
      id: "a",
      name: "A",
      email: "dup@example.com",
      handle: "h1",
      externalId: "s1",
    });
    seedUser(dbState, {
      id: "b",
      name: "B",
      email: "dup@example.com",
      handle: "h2",
      externalId: "s2",
    });
    const db = makeFakeDb(dbState);
    const admin = makeFakeAdmin({ users: new Map(), calls: [] });
    const log = recordingLogger();
    const code = await runResetLogtoUserPassword(
      { email: "dup@example.com", dryRun: true },
      { db, admin, logger: log },
    );
    expect(code).toBe(1);
    expect(log.lines.some((l) => l.includes("Ambiguous email"))).toBe(true);
  });

  test("refuses user without external_id", async () => {
    const dbState = { users: new Map(), hasExternalIdColumn: true };
    seedUser(dbState, {
      id: "u",
      name: "U",
      email: "orphan@example.com",
      handle: "orph",
      externalId: null,
    });
    const db = makeFakeDb(dbState);
    const admin = makeFakeAdmin({ users: new Map(), calls: [] });
    const log = recordingLogger();
    const code = await runResetLogtoUserPassword(
      { email: "orphan@example.com", dryRun: true },
      { db, admin, logger: log },
    );
    expect(code).toBe(1);
    expect(log.lines.some((l) => l.includes("no external_id"))).toBe(true);
  });

  test("apply rotates password, marks operator reset, writes file", async () => {
    const dbState = {
      users: new Map(),
      hasExternalIdColumn: true,
      hasLogtoAccountSecurityTable: true,
      operatorPasswordResetMarks: [] as string[],
    };
    seedUser(dbState, {
      id: "user-99",
      name: "Bob",
      email: "bob@example.com",
      handle: "bob",
      externalId: "logto-bob",
    });
    const db = makeFakeDb(dbState);
    const adminState = {
      users: new Map<string, LogtoUser>([
        [
          "logto-bob",
          {
            id: "logto-bob",
            isSuspended: false,
            primaryEmail: "bob@example.com",
            username: "bob",
          },
        ],
      ]),
      calls: [] as Array<{ method: string; args: unknown[] }>,
    };
    const admin = makeFakeAdmin(adminState);
    const log = recordingLogger();
    const written: Array<{ path: string; body: string }> = [];
    const code = await runResetLogtoUserPassword(
      { email: "bob@example.com", yes: true },
      {
        db,
        admin,
        logger: log,
        generatePassword: () => "TEMP_PW_HEX",
        isoStamp: () => "2026-04-30T12:00:00.000Z",
        writeSecretFile: (path, body) => written.push({ path, body }),
      },
    );
    expect(code).toBe(0);
    expect(adminState.calls.some((c) => c.method === "setUserPassword")).toBe(true);
    const sp = adminState.calls.find((c) => c.method === "setUserPassword");
    expect(sp?.args).toEqual(["logto-bob", "TEMP_PW_HEX"]);
    expect(dbState.operatorPasswordResetMarks).toEqual(["user-99"]);
    expect(written.length).toBe(1);
    expect(written[0]!.path).toContain("logto-password-reset-user-99-");
    expect(written[0]!.body).toContain("TEMP_PW_HEX");
    expect(log.lines.some((l) => l.includes("outcome=success"))).toBe(true);
    expect(
      log.lines.some((l) => l.includes(ACCOUNT_PASSWORD_RESET_OPERATOR_AUDIT)),
    ).toBe(true);
  });

  test("--dry-run wins over --yes (no mutations)", async () => {
    const dbState = {
      users: new Map(),
      hasExternalIdColumn: true,
      hasLogtoAccountSecurityTable: true,
    };
    seedUser(dbState, {
      id: "u1",
      name: "A",
      email: "a@b.com",
      handle: "a",
      externalId: "sub-1",
    });
    const db = makeFakeDb(dbState);
    const adminState = {
      users: new Map<string, LogtoUser>([
        [
          "sub-1",
          {
            id: "sub-1",
            isSuspended: false,
            primaryEmail: "a@b.com",
            username: "a",
          },
        ],
      ]),
      calls: [] as Array<{ method: string; args: unknown[] }>,
    };
    const admin = makeFakeAdmin(adminState);
    const log = recordingLogger();
    const code = await runResetLogtoUserPassword(
      { email: "a@b.com", yes: true, dryRun: true },
      { db, admin, logger: log },
    );
    expect(code).toBe(0);
    expect(adminState.calls.filter((c) => c.method === "setUserPassword")).toHaveLength(0);
  });
});
