/** D488 0B.6A.4 — complete-profile is the first durable owner boundary. */
import { beforeAll, describe, expect, mock, test } from "bun:test";

const invites = { kind: "invites" };
const inviteRedemptions = { kind: "inviteRedemptions" };
const users = { kind: "users" };
const actors = { kind: "actors" };
const credentials = { kind: "credentials" };
const channelIdentities = { kind: "channelIdentities" };
const profiles = { kind: "profiles" };
const rooms = { kind: "rooms" };
const groupMembers = { kind: "groupMembers" };
const roomMembers = { kind: "roomMembers" };
const groups = { kind: "groups" };
const groupRoles = { kind: "groupRoles" };
const roles = { kind: "roles" };

const invite = {
  id: "claim-1",
  kind: "claim",
  tokenHash: "hash",
  revokedAt: null,
  expiresAt: new Date("2099-08-07T12:10:00.000Z"),
  halfRedeemedAt: new Date("2099-08-07T12:00:00.000Z"),
  halfRedeemedUserId: "user-1",
  maxUses: 1,
  usedCount: 0,
  targetGroupId: null,
  targetRoomId: null,
};

function eq(): unknown { return {}; }
function and(): unknown { return {}; }
function isNull(): unknown { return {}; }
function ne(): unknown { return {}; }
function asc(): unknown { return {}; }

const updates: Array<{ table: unknown; value: Record<string, unknown> }> = [];
const ownerBoundTransitions: boolean[] = [];

function selectFor(table: unknown, actorSelectCount: { value: number }) {
  if (table === invites) return { where: () => ({ for: () => ({ limit: async () => [invite] }), limit: async () => [invite] }) };
  if (table === users) {
    const read = async () => [{ id: "user-1", handle: "alice", externalId: "sub-1" }];
    return { where: () => ({ limit: read, for: () => ({ limit: read }) }) };
  }
  if (table === actors) {
    actorSelectCount.value += 1;
    const row = actorSelectCount.value === 1 ? { id: "actor-user" } : { agentId: "agent-1" };
    return { where: () => ({ limit: async () => [row], orderBy: () => ({ limit: async () => [row] }) }) };
  }
  if (table === credentials) return { where: () => ({ limit: async () => [] }) };
  if (table === inviteRedemptions) return {
    where: () => ({
      for: () => ({ limit: async () => [{ completedAt: null, boundAdmissionEpoch: 0 }] }),
      limit: async () => [{ completedAt: null, boundAdmissionEpoch: 0 }],
    }),
  };
  if (table === rooms) return {
    innerJoin: () => ({
      where: () => ({ orderBy: () => ({ limit: async () => [{ id: "room-1" }] }) }),
    }),
  };
  throw new Error(`unexpected select ${String(table)}`);
}

function makeDb() {
  const probeActors = { value: 0 };
  const txActors = { value: 0 };
  const tx = {
    select: () => ({ from: (table: unknown) => selectFor(table, txActors) }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => { updates.push({ table, value }); },
      }),
    }),
    insert: (_table: unknown) => ({
      values: () => ({
        onConflictDoNothing: async () => {},
        onConflictDoUpdate: async () => {},
      }),
    }),
  };
  return {
    select: () => ({ from: (table: unknown) => selectFor(table, probeActors) }),
    transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
  };
}

beforeAll(() => {
  mock.module("@nautilo/db", () => ({
    getSharedDirectDb: makeDb,
    serverAdmission: { userId: "userId" },
    moderationAccessAllowedSql: () => ({}),
    sql: () => ({}),
    hasClaimedOwner: async () => false,
    inviteRedemptions, invites, users, actors, credentials, channelIdentities, groupMembers, profiles, rooms, roomMembers, groups, groupRoles, roles,
    eq, ne, and, asc, isNull,
    markPasswordChangeRequired: async () => {},
    PASSWORD_CHANGE_REASON: { SETUP_TEMP_PASSWORD: "setup_temp_password" },
    setTrustContextOnTx: async () => {},
    claimBootstrapSeedAgentInTx: async () => null,
    claimBootstrapSeedUserInTx: async () => null,
    seedPersonalAgentForInviteeInTx: async () => ({ agentId: "agent-1" }),
    seedPersonalPrivateRoomInTx: async () => ({ roomId: "room-1" }),
  }));
  mock.module("@nautilo/trust", () => ({
    prepareModerationEnrollmentInTx: async () => 0,
    completeModerationEnrollmentInTx: async () => 0,
    ModerationError: class extends Error {},
    hashPin: async () => "hashed-pin",
    generateRecoveryCodesInTx: async () => ["recovery"],
    findLocalUserByHandle: async () => null,
    updateRoomHumanActorsInTx: async () => {},
    resolveInviteLandingRoomInTx: async () => ({ roomId: "room-1", joinedExistingRoom: false }),
    setBootstrapOwnerId: () => {},
    setBootstrapOwnerBound: (value: boolean) => ownerBoundTransitions.push(value),
    setBootstrapDefaultAgentId: () => {},
  }));
});

describe("completeInviteProfile", () => {
  test("consumes the claim, revokes any remaining claim, then retires bootstrap", async () => {
    updates.length = 0;
    ownerBoundTransitions.length = 0;
    const marked: string[] = [];
    const { completeInviteProfile } = await import("../../src/lib/redeem-invite.ts");
    const result = await completeInviteProfile(
      "inv_" + "a".repeat(32),
      "sub-1",
      { displayName: "Alice", pin: "123456" },
      { bootstrapDirFn: () => "/tmp/bootstrap", markBootstrapUsedFn: (dir) => marked.push(dir) },
    );

    expect(result).toMatchObject({ ok: true, newUserId: "user-1" });
    const inviteUpdates: Record<string, unknown>[] = updates
      .filter((update) => update.table === invites)
      .map((update) => update.value);
    expect(inviteUpdates).toHaveLength(2);
    expect(inviteUpdates[0]).toEqual({
      usedCount: 1,
    });
    expect(inviteUpdates[1]?.["revokedAt"]).toBeInstanceOf(Date);
    const redemptionUpdates = updates
      .filter((update) => update.table === inviteRedemptions)
      .map((update) => update.value);
    expect(redemptionUpdates).toHaveLength(1);
    expect(redemptionUpdates[0]?.["completedAt"]).toBeInstanceOf(Date);
    expect(marked).toEqual(["/tmp/bootstrap"]);
    expect(ownerBoundTransitions).toEqual([true]);
  });
});
