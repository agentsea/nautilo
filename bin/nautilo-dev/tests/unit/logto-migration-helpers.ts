/**
 * Shared test fixtures for the M053 migrate-* commands. Implements the
 * `MigrationDb` and `LogtoAdmin` interfaces with simple in-memory state
 * so unit tests stay fast and free of any postgres / network deps.
 *
 * The fakes deliberately mirror the production interfaces' `async`
 * shape (every method returns a Promise) even though they're
 * synchronous internally — that's the contract the production callers
 * `await` against. Hence the file-level lint disable.
 */
/* eslint-disable @typescript-eslint/require-await */
import type {
  LogtoAdmin,
  LogtoUser,
  MigrationDb,
  MigrationLogger,
  MigrationUser,
} from "../../src/lib/logto-migration";

export interface FakeDbState {
  users: Map<string, MutableUser>;
  hasExternalIdColumn: boolean;
  /** When false, `hasLogtoAccountSecurityTable` reports missing D104 table. */
  hasLogtoAccountSecurityTable?: boolean;
  /** Force a connection failure on `hasExternalIdColumn` if set. */
  preflightError?: Error;
  /** User ids passed to `markMigrationTempPasswordRequired` (for assertions). */
  migrationTempPasswordMarks?: string[];
  /** User ids passed to `markOperatorPasswordResetRequired` (D104). */
  operatorPasswordResetMarks?: string[];
  /** M107 — `(userId, handle)` pairs passed to `backfillUserHandleIfNull`. */
  handleBackfills?: Array<{ userId: string; handle: string }>;
}

interface MutableUser {
  id: string;
  name: string;
  email: string | null;
  handle: string | null;
  externalId: string | null;
  /** Mirror of `users.server` — non-null = foreign-origin stub (skipped). */
  server: string | null;
}

export function makeFakeDb(state: FakeDbState): MigrationDb {
  const migrationTempPasswordMarks = (state.migrationTempPasswordMarks ??= []);
  const operatorPasswordResetMarks = (state.operatorPasswordResetMarks ??= []);
  return {
    listLocalUsers: async (onlyMissingExternalId) =>
      [...state.users.values()]
        .filter((u) => u.server === null)
        .filter((u) =>
          onlyMissingExternalId ? u.externalId === null : u.externalId !== null,
        )
        .map(toMigrationUser),
    setExternalId: async (userId, externalId) => {
      const u = state.users.get(userId);
      if (!u) throw new Error(`Test bug: user ${userId} not in fake DB`);
      u.externalId = externalId;
    },
    clearAllExternalIds: async () => {
      let count = 0;
      for (const u of state.users.values()) {
        if (u.server === null && u.externalId !== null) {
          u.externalId = null;
          count++;
        }
      }
      return count;
    },
    findLocalUserByEmail: async (email) => {
      for (const u of state.users.values()) {
        if (u.server === null && u.email === email) return toMigrationUser(u);
      }
      return null;
    },
    findLocalUsersByEmail: async (email) => {
      const out: MigrationUser[] = [];
      for (const u of state.users.values()) {
        if (u.server === null && u.email === email) out.push(toMigrationUser(u));
      }
      return out;
    },
    findLocalUsersByHandle: async (handle) => {
      const out: MigrationUser[] = [];
      for (const u of state.users.values()) {
        if (u.server === null && u.handle === handle) out.push(toMigrationUser(u));
      }
      return out;
    },
    findLocalUserById: async (userId) => {
      const u = state.users.get(userId);
      if (!u || u.server !== null) return null;
      return toMigrationUser(u);
    },
    markOperatorPasswordResetRequired: async (userId) => {
      operatorPasswordResetMarks.push(userId);
    },
    hasExternalIdColumn: async () => {
      if (state.preflightError) throw state.preflightError;
      return state.hasExternalIdColumn;
    },
    hasLogtoAccountSecurityTable: async () => {
      if (state.preflightError) throw state.preflightError;
      return state.hasLogtoAccountSecurityTable !== false;
    },
    markMigrationTempPasswordRequired: async (userId) => {
      migrationTempPasswordMarks.push(userId);
    },
    backfillUserHandleIfNull: async (userId, handle) => {
      const marks = (state.handleBackfills ??= []);
      marks.push({ userId, handle });
      const u = state.users.get(userId);
      if (u && u.handle === null) u.handle = handle;
    },
    listUsersInHandleCollisionGroups: async () => {
      const locals = [...state.users.values()].filter((u) => u.server === null);
      const byKey = new Map<string, MutableUser[]>();
      for (const u of locals) {
        const raw = u.handle?.trim();
        if (!raw) continue;
        const k = raw.toLowerCase();
        const list = byKey.get(k) ?? [];
        list.push(u);
        byKey.set(k, list);
      }
      const out: MigrationUser[] = [];
      for (const group of byKey.values()) {
        if (group.length > 1) {
          for (const u of group) out.push(toMigrationUser(u));
        }
      }
      return out;
    },
    end: async () => {
      /* no-op for fakes */
    },
  };
}

function toMigrationUser(u: MutableUser): MigrationUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    handle: u.handle,
    externalId: u.externalId,
  };
}

export interface FakeAdminState {
  users: Map<string, LogtoUser>;
  /** Sequence of subs to mint on createUser. Defaults to "logto-1, logto-2, ...". */
  nextSubs?: string[];
  /** When true, getAccessToken throws (M2M creds invalid). */
  m2mFails?: boolean;
  /** Optional HTTP status overrides for `patchUser` keyed by Logto user id. */
  patchUserStatusByUserId?: Map<string, number>;
  /** Records every method invocation in order. */
  calls: Array<{ method: string; args: unknown[] }>;
}

export function makeFakeAdmin(state: FakeAdminState): LogtoAdmin {
  let mintCounter = 0;
  function track(method: string, args: unknown[]) {
    state.calls.push({ method, args });
  }
  return {
    getAccessToken: async (audience) => {
      track("getAccessToken", [audience]);
      if (state.m2mFails) throw new Error("Logto M2M token failed: 401");
      return "fake-token";
    },
    createUser: async (args) => {
      track("createUser", [args]);
      let sub: string;
      if (state.nextSubs && state.nextSubs.length > 0) {
        sub = state.nextSubs.shift()!;
      } else {
        mintCounter++;
        sub = `logto-${mintCounter}`;
      }
      const user: LogtoUser = {
        id: sub,
        isSuspended: false,
        primaryEmail: args.primaryEmail ?? null,
        username: args.username,
      };
      state.users.set(sub, user);
      return { id: sub };
    },
    setUserPassword: async (userId, password) => {
      track("setUserPassword", [userId, password]);
      const u = state.users.get(userId);
      if (u) state.users.set(userId, { ...u });
    },
    deleteUser: async (userId) => {
      track("deleteUser", [userId]);
      state.users.delete(userId);
    },
    findUserByEmailOrUsername: async (email, username) => {
      track("findUserByEmailOrUsername", [email, username]);
      for (const u of state.users.values()) {
        if (email && u.primaryEmail === email) return u;
      }
      for (const u of state.users.values()) {
        if (username && u.username === username) return u;
      }
      return null;
    },
    getUser: async (userId) => {
      track("getUser", [userId]);
      return state.users.get(userId) ?? null;
    },
    patchUser: async (userId, body) => {
      track("patchUser", [userId, body]);
      const forced = state.patchUserStatusByUserId?.get(userId);
      if (forced !== undefined) return forced;
      const u = state.users.get(userId);
      if (u && typeof (body as { username?: string }).username === "string") {
        state.users.set(userId, {
          ...u,
          username: (body as { username: string }).username,
        });
      }
      return 200;
    },
  };
}

export function recordingLogger(): MigrationLogger & {
  lines: string[];
  tableRows: Array<ReadonlyArray<Record<string, unknown>>>;
} {
  const lines: string[] = [];
  const tableRows: Array<ReadonlyArray<Record<string, unknown>>> = [];
  return {
    lines,
    tableRows,
    info: (msg) => lines.push(`[info] ${msg}`),
    warn: (msg) => lines.push(`[warn] ${msg}`),
    error: (msg) => lines.push(`[error] ${msg}`),
    table: (rows) => tableRows.push(rows),
  };
}

export function seedUser(
  state: FakeDbState,
  partial: Partial<MutableUser> & { id: string; name: string },
): void {
  // Distinguish "not supplied" (undefined → default) from "explicit null".
  state.users.set(partial.id, {
    id: partial.id,
    name: partial.name,
    email:
      "email" in partial ? partial.email ?? null : `${partial.id}@example.com`,
    handle: "handle" in partial ? partial.handle ?? null : partial.id,
    externalId:
      "externalId" in partial ? partial.externalId ?? null : null,
    server: "server" in partial ? partial.server ?? null : null,
  });
}
