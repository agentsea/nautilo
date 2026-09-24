/**
 * M091 Phase 5 — after successful `kind=claim` redeem, `.bootstrap/.used` is scheduled.
 *
 * **Isolated runner**: `mock.module("@nautilo/db")` / `@nautilo/trust` cannot be undone
 * with `mock.restore()` in Bun and leaks into other unit test files if co-located under
 * `tests/unit/`. This file runs in a separate `bun test` invocation (see package.json).
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

const invites = { __kind: "invites" as const };
const inviteRedemptions = { __kind: "inviteRedemptions" as const };
const users = { __kind: "users" as const };
const actors = { __kind: "actors" as const };
const credentials = { __kind: "credentials" as const };
const channelIdentities = { __kind: "channelIdentities" as const };
const groupMembers = { __kind: "groupMembers" as const };
const groups = { __kind: "groups" as const };
const groupRoles = { __kind: "groupRoles" as const };
const roles = { __kind: "roles" as const };
let targetRoleSlug = "member";
const groupMembershipWrites: string[] = [];
const profiles = { __kind: "profiles" as const };
const rooms = { __kind: "rooms" as const };
const roomMembers = { __kind: "roomMembers" as const };

const inviteRowState = {
  id: "00000000-0000-0000-0000-00000000c1a1",
  kind: "claim" as "claim" | "server",
  tokenHash: "dummy",
  revokedAt: null,
  expiresAt: null,
  maxUses: 1,
  usedCount: 0,
  targetGroupId: null as string | null,
  targetRoomId: null as string | null,
};

function eq(): unknown {
  return {};
}

function and(): unknown {
  return {};
}

function ne(): unknown {
  return {};
}

function asc(): unknown {
  return {};
}

// M107 Phase 2c: `redeem-invite.ts` imports `isNull` for the bind-time
// handle-collision pre-check. The mocked tx doesn't execute the real
// predicate; we just need a callable stub so the module loads.
function isNull(): unknown {
  return {};
}

function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === invites) {
          return {
            where: () => ({
              for: () => ({
                limit: () => Promise.resolve([inviteRowState]),
              }),
              limit: () => Promise.resolve([inviteRowState]),
            }),
          };
        }
        // M107 Phase 2c: bind-time handle-collision pre-check selects
        // from `users`; the test fixture has no concurrent claimer for
        // this handle, so return an empty result set.
        if (table === users) {
          return {
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          };
        }
        if (table === groups) {
          return { leftJoin: () => ({ leftJoin: () => ({
            where: () => Promise.resolve([{ groupType: targetRoleSlug === "community" ? "communities" : "members", roleSlug: targetRoleSlug }]),
          }) }) };
        }
        throw new Error(`unexpected select.from in tx: ${String(table)}`);
      },
    }),
    insert: (table: unknown) => ({
      values: () => {
        if (table === users) {
          return {
            returning: () => Promise.resolve([{ id: "user-1" }]),
          };
        }
        if (table === actors) {
          return {
            returning: () => Promise.resolve([{ id: "actor-1" }]),
          };
        }
        if (table === channelIdentities) {
          return {
            onConflictDoNothing: () => Promise.resolve(),
          };
        }
        if (table === credentials) {
          return Promise.resolve();
        }
        if (table === profiles) {
          return {
            onConflictDoUpdate: () => Promise.resolve(),
          };
        }
        if (table === groupMembers) {
          return {
            onConflictDoNothing: () => { groupMembershipWrites.push("insert"); return Promise.resolve(); },
          };
        }
        if (table === roomMembers) {
          return Promise.resolve();
        }
        if (table === inviteRedemptions) {
          return {
            onConflictDoNothing: () => Promise.resolve(),
          };
        }
        throw new Error(`unexpected insert table ${String(table)}`);
      },
    }),
    update: (table: unknown) => {
      if (table === invites) {
        return {
          set: () => ({
            where: () => Promise.resolve(),
          }),
        };
      }
      throw new Error(`unexpected update table ${String(table)}`);
    },
  };
}

function getSharedDirectDb() {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === invites) {
          return {
            where: () => ({
              limit: () => Promise.resolve([inviteRowState]),
            }),
          };
        }
        throw new Error("unexpected probe select");
      },
    }),
    transaction: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      fn(makeTx()),
  };
}

beforeAll(() => {
  mock.module("@nautilo/db", () => ({
    getSharedDirectDb,
    serverAdmission: { userId: "userId" },
    moderationAccessAllowedSql: () => ({}),
    sql: () => ({}),
    hasClaimedOwner: async () => false,
    inviteRedemptions,
    invites,
    users,
    actors,
    credentials,
    channelIdentities,
    groupMembers,
    profiles,
    rooms,
    roomMembers,
    groups,
    groupRoles,
    roles,
    eq,
    ne,
    and,
    asc,
    isNull,
    markPasswordChangeRequired: async () => {},
    PASSWORD_CHANGE_REASON: { SETUP_TEMP_PASSWORD: "setup_temp_password" },
    setTrustContextOnTx: async () => {},
    // D140: helpers return null in the mocked unit test → caller falls
    // back to the existing INSERT path (the original behavior the
    // bootstrap-.used sentinel test was written against).
    claimBootstrapSeedAgentInTx: async () => null,
    claimBootstrapSeedUserInTx: async () => null,
    seedPersonalAgentForInviteeInTx: async () => ({
      agentId: "agent-1",
    }),
    seedPersonalPrivateRoomInTx: async () => ({ roomId: "room-1" }),
    // M128 D2: seedInviterAgentPrivateRoomInTx removed — never called by the redeem path.
  }));

  mock.module("@nautilo/trust", () => ({
    prepareModerationEnrollmentInTx: async () => 0,
    completeModerationEnrollmentInTx: async () => 0,
    ModerationError: class extends Error {},
    hashPin: async () => "hashed-pin",
    generateRecoveryCodesInTx: async () => ["rc1", "rc2"],
    findLocalUserByHandle: async () => null,
    updateRoomHumanActorsInTx: async () => {},
    resolveInviteLandingRoomInTx: async () => ({ roomId: "room-1", joinedExistingRoom: false }),
    setBootstrapOwnerId: () => {},
    setBootstrapOwnerBound: () => {},
    setBootstrapDefaultAgentId: () => {},
  }));
});

describe("redeemInviteAtomically — bootstrap .used sentinel", () => {
  test("marks bootstrap dir only for kind=claim (sequential; shared mock state)", async () => {
    const marked: string[] = [];
    const { redeemInviteAtomically } = await import("../../src/lib/redeem-invite.ts");
    const logto = {
      findUserByEmailOrUsername: async () => null,
      createUser: async () => ({ id: "logto-sub-1" }),
      deleteUser: async () => {},
    };

    inviteRowState.kind = "claim";
    inviteRowState.targetGroupId = null;
    inviteRowState.targetRoomId = null;

    const claimRes = await redeemInviteAtomically(
      "inv_testtokenclaim",
      {
        handle: "alice",
        displayName: "Alice",
        password: "Str0ng!Pass",
        pin: "123456",
      },
      {
        logto: logto as never,
        markBootstrapUsedFn: (dir) => {
          marked.push(dir);
        },
        bootstrapDirFn: () => "/tmp/.nautilo-testinst/.bootstrap",
        allowLogtoSessionMint: false,
      },
    );
    expect(claimRes.ok).toBe(true);
    expect(marked).toEqual(["/tmp/.nautilo-testinst/.bootstrap"]);

    marked.length = 0;
    inviteRowState.kind = "server";
    inviteRowState.targetGroupId = "group-x";
    inviteRowState.targetRoomId = null;

    const serverRes = await redeemInviteAtomically(
      "inv_srvtoken",
      {
        handle: "bob",
        displayName: "Bob",
        password: "Str0ng!Pass",
        pin: "654321",
      },
      {
        logto: logto as never,
        markBootstrapUsedFn: (dir) => {
          marked.push(dir);
        },
        bootstrapDirFn: () => "/should-not-run",
        allowLogtoSessionMint: false,
      },
    );
    expect(serverRes.ok).toBe(true);
    expect(marked).toEqual([]);
  });

  test("an outstanding invite cannot enroll a Human into Community during the dormant phase", async () => {
    const { redeemInviteAtomically } = await import("../../src/lib/redeem-invite.ts");
    inviteRowState.kind = "server";
    inviteRowState.targetGroupId = "group-x";
    targetRoleSlug = "community";
    groupMembershipWrites.length = 0;
    try {
      const result = await redeemInviteAtomically("inv_srvtoken", {
        handle: "charlie", displayName: "Candidate", password: "Str0ng!Pass", pin: "123456",
      }, { logto: { findUserByEmailOrUsername: async () => null,
        createUser: async () => ({ id: "logto-sub-2" }), deleteUser: async () => {} } as never,
        allowLogtoSessionMint: false });
      expect(result).toMatchObject({ ok: false, httpStatus: 409, code: "community_enrollment_unavailable" });
      expect(groupMembershipWrites).toEqual([]);
    } finally {
      targetRoleSlug = "member";
    }
  });
});
