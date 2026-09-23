/**
 * D488 0B.6A.4 — a successful Logto bind is only a resumable half-claim.
 * It must not consume bootstrap authority before complete-profile persists
 * the PIN/profile/used-count owner projection.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const invites = { kind: "invites" };
const inviteRedemptions = { kind: "inviteRedemptions" };
const users = { kind: "users" };
const actors = { kind: "actors" };
const roomMembers = { kind: "roomMembers" };
const groupMembers = { kind: "groupMembers" };
const profiles = { kind: "profiles" };
const rooms = { kind: "rooms" };
const credentials = { kind: "credentials" };
const channelIdentities = { kind: "channelIdentities" };
const groups = { kind: "groups" };
const groupRoles = { kind: "groupRoles" };
const roles = { kind: "roles" };
const ownerBoundTransitions: boolean[] = [];
let legacyExistingUser = false;
let bindingUserId: string | null = null;

const invite = {
  id: "claim-1",
  kind: "claim",
  tokenHash: "hash",
  revokedAt: null,
  expiresAt: new Date("2099-08-07T12:10:00.000Z"),
  maxUses: 1,
  usedCount: 0,
  halfRedeemedAt: null,
  halfRedeemedUserId: null,
  targetGroupId: null,
  targetRoomId: null,
};

function eq(): unknown {
  return {};
}
function and(): unknown {
  return {};
}
function isNull(): unknown {
  return {};
}
function ne(): unknown { return {}; }
function asc(): unknown { return {}; }

function makeTx() {
  let usersSelects = 0;
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === invites) {
          return { where: () => ({ for: () => ({ limit: async () => [invite] }) }) };
        }
        if (table === inviteRedemptions) {
          return {
            innerJoin: () => ({
              where: () => ({
                limit: async () => bindingUserId
                  ? [{ id: bindingUserId, externalId: "logto-sub-1" }]
                  : [],
              }),
            }),
            where: () => ({
              limit: async () => bindingUserId ? [{ userId: bindingUserId }] : [],
            }),
          };
        }
        if (table === users) {
          usersSelects += 1;
          return {
            where: () => ({
              limit: async () => legacyExistingUser
                ? [{ id: "user-1", externalId: "logto-sub-1" }]
                : [],
            }),
          };
        }
        if (table === actors) {
          return { where: () => ({ limit: async () => [{ id: "actor-1" }] }) };
        }
        if (table === rooms) {
          return {
            innerJoin: () => ({ where: () => ({ limit: async () => [{ id: "room-1" }] }) }),
          };
        }
        throw new Error(`unexpected tx select ${String(table)} #${usersSelects}`);
      },
    }),
    insert: (table: unknown) => {
      expect(table).toBe(inviteRedemptions);
      return {
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            bindingUserId = value["userId"] as string;
          },
        }),
      };
    },
  };
}

function getSharedDirectDb() {
  let probeUsers = 0;
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === invites) return { where: () => ({ limit: async () => [invite] }) };
        if (table === users) {
          probeUsers += 1;
          return { where: () => ({ limit: async () => [] }) };
        }
        throw new Error(`unexpected probe select ${String(table)} #${probeUsers}`);
      },
    }),
    transaction: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(makeTx()),
  };
}

beforeAll(() => {
  mock.module("@nautilo/db", () => ({
    getSharedDirectDb,
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
    claimBootstrapSeedUserInTx: async () => ({ userId: "user-1", userActorId: "actor-1" }),
    claimBootstrapSeedAgentInTx: async () => ({ agentId: "agent-1" }),
    seedPersonalAgentForInviteeInTx: async () => ({ agentId: "agent-2" }),
    seedPersonalPrivateRoomInTx: async () => ({ roomId: "room-2" }),
  }));
  mock.module("@nautilo/trust", () => ({
    hashPin: async () => "hash",
    generateRecoveryCodesInTx: async () => [],
    findLocalUserByHandle: async () => null,
    updateRoomHumanActorsInTx: async () => {},
    resolveInviteLandingRoomInTx: async () => ({ roomId: "room-1", joinedExistingRoom: false }),
    setBootstrapOwnerId: () => {},
    setBootstrapOwnerBound: (value: boolean) => ownerBoundTransitions.push(value),
    setBootstrapDefaultAgentId: () => {},
  }));
});

describe("redeemInviteWithLogtoSub", () => {
  beforeEach(() => {
    bindingUserId = null;
    legacyExistingUser = false;
  });

  test("does not retire bootstrap authority at the half-bind", async () => {
    const marked: string[] = [];
    ownerBoundTransitions.length = 0;
    const { redeemInviteWithLogtoSub } = await import("../../src/lib/redeem-invite.ts");

    const result = await redeemInviteWithLogtoSub(
      "inv_" + "a".repeat(32),
      "logto-sub-1",
      { handle: "alice", displayName: "Alice" },
      {
        bootstrapDirFn: () => "/tmp/bootstrap",
        markBootstrapUsedFn: (dir) => marked.push(dir),
      },
    );

    expect(result).toMatchObject({ ok: true, userId: "user-1", actorId: "actor-1" });
    expect(bindingUserId).toBe("user-1");
    expect(marked).toEqual([]);
    expect(ownerBoundTransitions).toEqual([]);
  });

  test("same-sub retry is idempotent and a different subject cannot steal the reservation", async () => {
    const { redeemInviteWithLogtoSub } = await import("../../src/lib/redeem-invite.ts");
    const deps = { bootstrapDirFn: () => "/tmp/bootstrap", markBootstrapUsedFn: () => {} };
    bindingUserId = "user-1";

    const retry = await redeemInviteWithLogtoSub(
      "inv_" + "a".repeat(32),
      "logto-sub-1",
      { handle: "alice", displayName: "Alice" },
      deps,
    );
    expect(retry).toMatchObject({ ok: true, userId: "user-1", actorId: "actor-1" });

    const attacker = await redeemInviteWithLogtoSub(
      "inv_" + "a".repeat(32),
      "logto-sub-2",
      { handle: "mallory", displayName: "Mallory" },
      deps,
    );
    expect(attacker).toEqual({
      ok: false,
      httpStatus: 409,
      error: "claim_reserved",
      code: "claim_reserved",
    });
  });

  test("does not attach an existing Logto subject without this Invite's binding", async () => {
    const { redeemInviteWithLogtoSub } = await import("../../src/lib/redeem-invite.ts");
    legacyExistingUser = true;
    const result = await redeemInviteWithLogtoSub(
      "inv_" + "a".repeat(32),
      "logto-sub-1",
      { handle: "alice", displayName: "Alice" },
      { bootstrapDirFn: () => "/tmp/bootstrap", markBootstrapUsedFn: () => {} },
    );

    expect(result).toEqual({
      ok: false,
      httpStatus: 409,
      error: "logto_subject_already_bound",
      code: "logto_subject_already_bound",
    });
    expect(bindingUserId).toBeNull();
  });
});
