/**
 * M053 — `runMigrateToLogto` unit tests.
 *
 * The pure runner takes a `MigrationDeps` so we never touch Postgres or
 * a real Logto endpoint. Each branch (preflight failure, dry-run, happy
 * path, idempotency, missing email/handle skip, existing-Logto attach)
 * gets its own test.
 */
import { describe, test, expect } from "bun:test";
import { LOGTO_REQUIRED_KEYS } from "@nautilo/config-guard";
import {
  runMigrateToLogto,
  type MigrateToLogtoArgs,
  type MigrateToLogtoDeps,
} from "../../src/commands/migrate-to-logto";
import {
  makeFakeAdmin,
  makeFakeDb,
  recordingLogger,
  seedUser,
  type FakeAdminState,
  type FakeDbState,
} from "./logto-migration-helpers";

interface CapturedFile {
  path: string;
  contents: string;
}

interface Harness {
  dbState: FakeDbState;
  adminState: FakeAdminState;
  logger: ReturnType<typeof recordingLogger>;
  files: CapturedFile[];
  env: NodeJS.ProcessEnv;
  fetchCalls: string[];
  deps: MigrateToLogtoDeps;
}

function fullEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of LOGTO_REQUIRED_KEYS) env[k] = `value-of-${k}`;
  return env;
}

function makeHarness(opts: {
  envOverride?: NodeJS.ProcessEnv;
  fetchOk?: boolean;
} = {}): Harness {
  const dbState: FakeDbState = {
    users: new Map(),
    hasExternalIdColumn: true,
  };
  const adminState: FakeAdminState = {
    users: new Map(),
    calls: [],
  };
  const logger = recordingLogger();
  const files: CapturedFile[] = [];
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

  const env = opts.envOverride ?? fullEnv();
  let pwCounter = 0;
  const deps: MigrateToLogtoDeps = {
    db: makeFakeDb(dbState),
    admin: makeFakeAdmin(adminState),
    logger,
    writeClaimInvitations: async (path, contents) => {
      files.push({ path, contents });
    },
    env,
    fetchImpl,
    sleepMs: async () => {
      /* skip rate-limit pause in tests */
    },
    generateTempPassword: () => {
      pwCounter++;
      return `temp-pw-${pwCounter}`;
    },
  };
  return {
    dbState,
    adminState,
    logger,
    files,
    env,
    fetchCalls,
    deps,
  };
}

const NO_ARGS: MigrateToLogtoArgs = {};

describe("runMigrateToLogto — preflight", () => {
  test("exits 1 when a LOGTO_* env var is missing", async () => {
    const env = fullEnv();
    delete env["LOGTO_M2M_APP_SECRET"];
    const h = makeHarness({ envOverride: env });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(1);
    expect(h.logger.lines.join("\n")).toContain("LOGTO_M2M_APP_SECRET");
    // No DB or admin calls before preflight passes.
    expect(h.adminState.calls.length).toBe(0);
    expect(h.fetchCalls.length).toBe(0);
  });

  test("exits 1 when users.external_id column is missing (M051 not applied)", async () => {
    const h = makeHarness();
    h.dbState.hasExternalIdColumn = false;
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(1);
    expect(h.logger.lines.join("\n")).toContain("external_id column");
    // Logto admin never invoked.
    expect(h.adminState.calls.length).toBe(0);
  });

  test("exits 1 when Logto discovery probe fails", async () => {
    const h = makeHarness({ fetchOk: false });
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(1);
    expect(h.logger.lines.join("\n")).toContain("Logto");
  });

  test("exits 1 when M2M credentials are invalid", async () => {
    const h = makeHarness();
    h.adminState.m2mFails = true;
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(1);
    expect(h.logger.lines.join("\n")).toContain("M2M token mint");
    // Critically: no createUser / setExternalId calls happened.
    expect(
      h.adminState.calls.find((c) => c.method === "createUser"),
    ).toBeUndefined();
    expect(h.dbState.users.get("u1")?.externalId).toBeNull();
  });
});

describe("runMigrateToLogto — happy path", () => {
  test("returns 0 with no candidates when all users are already linked", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      externalId: "logto-existing",
    });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(h.logger.lines.some((l) => l.includes("No users to migrate"))).toBe(
      true,
    );
    expect(h.files.length).toBe(0);
  });

  test("--dry-run lists candidates and makes zero mutations or Logto calls", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    seedUser(h.dbState, { id: "u2", name: "Bob" });
    const code = await runMigrateToLogto({ dryRun: true }, h.deps);
    expect(code).toBe(0);
    expect(h.logger.tableRows.length).toBe(1);
    expect(h.logger.tableRows[0]!.length).toBe(2);
    // Neither DB rows nor Logto state moved.
    for (const u of h.dbState.users.values()) {
      expect(u.externalId).toBeNull();
    }
    expect(
      h.adminState.calls.find(
        (c) => c.method === "createUser" || c.method === "findUserByEmailOrUsername",
      ),
    ).toBeUndefined();
    expect(h.files.length).toBe(0);
  });

  test("creates Logto users + writes external_id + emits claim invitations", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
    });
    seedUser(h.dbState, {
      id: "u2",
      name: "Bob",
      email: "bob@example.com",
      handle: "bob",
    });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(h.dbState.users.get("u1")?.externalId).toBe("logto-1");
    expect(h.dbState.users.get("u2")?.externalId).toBe("logto-2");
    expect(h.adminState.users.size).toBe(2);
    expect(h.files.length).toBe(1);
    expect(h.files[0]!.contents).toContain("alice@example.com");
    expect(h.files[0]!.contents).toContain("bob@example.com");
    expect(h.files[0]!.contents).toContain("logto-1");
    expect(h.files[0]!.contents).toContain("Temporary password: temp-pw-1");
    expect(h.files[0]!.contents).toContain("Temporary password: temp-pw-2");
    // The createUser POST included the password.
    const createCall = h.adminState.calls.find(
      (c) => c.method === "createUser",
    );
    const args = createCall!.args[0] as { password?: string };
    expect(args.password).toBe("temp-pw-1");
  });

  test("re-attaching an existing Logto user does NOT print a temp password", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
    });
    h.adminState.users.set("logto-pre", {
      id: "logto-pre",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    await runMigrateToLogto(NO_ARGS, h.deps);
    const contents = h.files[0]!.contents;
    expect(contents).toContain("Logto account already existed");
    expect(contents).not.toContain("Temporary password:");
  });

  test("foreign-origin stubs (server IS NOT NULL) are skipped", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    seedUser(h.dbState, {
      id: "stub",
      name: "Remote",
      server: "other.example.com",
    });
    await runMigrateToLogto(NO_ARGS, h.deps);
    expect(h.dbState.users.get("u1")?.externalId).toBe("logto-1");
    expect(h.dbState.users.get("stub")?.externalId).toBeNull();
    expect(h.adminState.users.size).toBe(1);
  });
});

describe("runMigrateToLogto — idempotency + edge cases", () => {
  test("re-running after success finds zero candidates (idempotent)", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    await runMigrateToLogto(NO_ARGS, h.deps);
    expect(h.dbState.users.get("u1")?.externalId).toBe("logto-1");
    h.logger.lines.length = 0;
    h.adminState.calls.length = 0;
    h.files.length = 0;
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(h.logger.lines.some((l) => l.includes("No users to migrate"))).toBe(
      true,
    );
    expect(
      h.adminState.calls.find((c) => c.method === "createUser"),
    ).toBeUndefined();
    expect(h.files.length).toBe(0);
  });

  test("re-attaches via findUserByEmailOrUsername after rollback (no duplicate)", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      handle: "alice",
    });
    // Simulate a prior round-trip: Logto account exists; users.external_id NULL.
    h.adminState.users.set("logto-pre-existing", {
      id: "logto-pre-existing",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(h.dbState.users.get("u1")?.externalId).toBe("logto-pre-existing");
    expect(
      h.adminState.calls.find((c) => c.method === "createUser"),
    ).toBeUndefined();
    expect(h.adminState.users.size).toBe(1);
  });

  test("skips users with no email or handle and logs a warning", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Alice",
      email: null,
      handle: "alice",
    });
    seedUser(h.dbState, {
      id: "u2",
      name: "Bob",
      email: "bob@example.com",
      handle: null,
    });
    seedUser(h.dbState, {
      id: "u3",
      name: "Carol",
      email: "carol@example.com",
      handle: "carol",
    });
    const code = await runMigrateToLogto(NO_ARGS, h.deps);
    expect(code).toBe(0);
    expect(h.dbState.users.get("u1")?.externalId).toBeNull();
    expect(h.dbState.users.get("u2")?.externalId).toBeNull();
    expect(h.dbState.users.get("u3")?.externalId).toBe("logto-1");
    expect(
      h.logger.lines.filter((l) => l.startsWith("[warn]")).length,
    ).toBeGreaterThanOrEqual(2);
    // Only one claim invitation written (Carol).
    expect(h.files.length).toBe(1);
  });

  test("honors --output override path", async () => {
    const h = makeHarness();
    seedUser(h.dbState, { id: "u1", name: "Alice" });
    await runMigrateToLogto(
      { outputPath: "/tmp/custom-claims.txt" },
      h.deps,
    );
    expect(h.files[0]!.path).toBe("/tmp/custom-claims.txt");
  });
});

describe("renderClaimInvitations format", () => {
  test("includes the chmod-600 reminder header and per-user blocks", async () => {
    const h = makeHarness();
    seedUser(h.dbState, {
      id: "u1",
      name: "Test User",
      email: "test-user@example.com",
      handle: "test-user",
    });
    await runMigrateToLogto(NO_ARGS, h.deps);
    const contents = h.files[0]!.contents;
    expect(contents).toContain("# Nautilo → Logto migration");
    expect(contents).toContain("Test User  <test-user@example.com>");
    expect(contents).toContain("Handle: @test-user");
    expect(contents).toContain("Logto sub: logto-1");
  });
});
