import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  accountDeletionPhotoCleanup,
  actors,
  and,
  eq,
  inArray,
  groupMembers,
  groups,
  namespaces,
  profiles,
  roomMembers,
  rooms,
  users,
} from "@nautilo/db";

/**
 * The six canonical ladder Group types (owners > admins > superusers >
 * members > contributors > guests). D418 Wave 2 makes these
 * system-managed (`is_system=true`, `owner_id=NULL`) so hard-deleting the
 * bootstrap owner cannot cascade them away.
 */
const CANONICAL_LADDER_GROUP_TYPES = [
  "owners",
  "admins",
  "superusers",
  "members",
  "contributors",
  "guests",
] as const;
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import {
  _resetLogtoAdminClientForTests,
  _setLogtoAdminClientForTests,
  type LogtoAdminClient,
} from "../../../trust/src/logto-admin";
import {
  isSafelyTerminalMediaOperation,
  reconcileAccountDeletionPhotoCleanup,
} from "../../src/lib/user-account-deletion";

describe("admin users hard delete (D220 Stack 66)", () => {
  test("only fully reconciled provider work is terminal for account deletion", () => {
    expect(isSafelyTerminalMediaOperation({
      providerQueueId: null,
      state: "prequeue",
      cleanupState: "pending",
    })).toBe(true);
    expect(isSafelyTerminalMediaOperation({
      providerQueueId: "provider-queue",
      state: "queued",
      cleanupState: "pending",
    })).toBe(false);
    expect(isSafelyTerminalMediaOperation({
      providerQueueId: "provider-queue",
      state: "unknown",
      cleanupState: "pending",
    })).toBe(false);
    expect(isSafelyTerminalMediaOperation({
      providerQueueId: "provider-queue",
      state: "ready",
      cleanupState: "pending",
    })).toBe(false);
    expect(isSafelyTerminalMediaOperation({
      providerQueueId: "provider-queue",
      state: "ready",
      cleanupState: "completed",
    })).toBe(true);
    expect(isSafelyTerminalMediaOperation({
      providerQueueId: "provider-queue",
      state: "failed",
      cleanupState: "pending",
    })).toBe(true);
  });

  test("reconciles a committed account-photo cleanup after an interruption", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d539photoretry" });
    const cleanupId = randomUUID();
    let nowMs = Date.now();
    let removals = 0;
    try {
      await fx.db.insert(accountDeletionPhotoCleanup).values({
        id: cleanupId,
        serverInstanceId: randomUUID(),
        avatarKind: "uploaded",
        blobId: `d539-${randomUUID()}`,
      });

      // This is the crash window: database ownership is already committed,
      // physical removal succeeded, but the final receipt delete did not.
      expect(await reconcileAccountDeletionPhotoCleanup({
        db: fx.db,
        now: () => new Date(nowMs),
        removeMedia: async () => { removals += 1; },
        afterRemoveMedia: async () => { throw new Error("interrupted-after-remove"); },
      })).toBe(0);
      expect(removals).toBe(1);
      expect(await fx.db.select({ id: accountDeletionPhotoCleanup.id })
        .from(accountDeletionPhotoCleanup)
        .where(eq(accountDeletionPhotoCleanup.id, cleanupId))).toHaveLength(1);

      nowMs += 16 * 60 * 1000;
      expect(await reconcileAccountDeletionPhotoCleanup({
        db: fx.db,
        now: () => new Date(nowMs),
        // A missing blob is a successful, idempotent filesystem outcome.
        removeMedia: async () => { removals += 1; },
      })).toBe(1);
      expect(removals).toBe(2);
      expect(await fx.db.select({ id: accountDeletionPhotoCleanup.id })
        .from(accountDeletionPhotoCleanup)
        .where(eq(accountDeletionPhotoCleanup.id, cleanupId))).toHaveLength(0);
    } finally {
      await fx.db.delete(accountDeletionPhotoCleanup)
        .where(eq(accountDeletionPhotoCleanup.id, cleanupId));
      await fx.cleanup();
    }
  }, 60000);

  test("a freshly reauthenticated member can assess and delete their own local account", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d539selfdel" });
    let peerUserId: string | null = null;
    let peerRoomId: string | null = null;
    let peerNamespaceId: string | null = null;
    const revokedLogtoUserIds: string[] = [];
    try {
      const peer = await seatPeerUser(fx.db, {
        suiteName: "d539selfdel",
        groupType: "members",
      });
      peerUserId = peer.userId;
      const [peerUser] = await fx.db
        .select({ externalId: users.externalId })
        .from(users)
        .where(eq(users.id, peer.userId))
        .limit(1);
      if (!peerUser?.externalId) throw new Error("peer external identity missing");
      _setLogtoAdminClientForTests({
        isUserActive: () => Promise.resolve(true),
        deleteUser: (logtoUserId: string) => {
          revokedLogtoUserIds.push(logtoUserId);
          return Promise.resolve();
        },
      } as unknown as LogtoAdminClient);
      const [peerAgentActor] = await fx.db
        .select({ id: actors.id })
        .from(actors)
        .where(and(eq(actors.ownerId, peer.userId), eq(actors.agentId, peer.agentId)))
        .limit(1);
      if (!peerAgentActor) throw new Error("peer agent actor missing");
      const [peerNamespace] = await fx.db
        .insert(namespaces)
        .values({ scope: "private", label: "D539 peer private namespace" })
        .returning({ id: namespaces.id });
      if (!peerNamespace) throw new Error("peer namespace insert failed");
      peerNamespaceId = peerNamespace.id;
      const roomId = randomUUID();
      await fx.db.insert(rooms).values({
        id: roomId,
        ownerId: peer.userId,
        type: "private",
        label: "D539 peer private Room",
        graphThreadId: `room:${roomId}`,
        namespaceId: peerNamespace.id,
        humanActorIds: [peer.actorId],
        createdBy: peer.actorId,
      });
      peerRoomId = roomId;
      await fx.db.insert(roomMembers).values([
        { roomId, actorId: peer.actorId, roomRole: "admin" },
        { roomId, actorId: peerAgentActor.id, roomRole: "member" },
      ]);

      const eligibility = await authedInject(fx.app, {
        method: "GET",
        url: "/api/account/deletion/eligibility",
        bearer: peer.bearer,
      });
      expect(eligibility.statusCode).toBe(200);
      expect(JSON.parse(eligibility.body)).toEqual({ eligible: true });

      const missingConfirmation = await authedInject(fx.app, {
        method: "DELETE",
        url: "/api/account",
        bearer: peer.bearer,
        payload: { confirmation: "delete" },
      });
      expect(missingConfirmation.statusCode).toBe(400);
      expect(JSON.parse(missingConfirmation.body)).toMatchObject({
        code: "confirmation_required",
      });

      const deleted = await authedInject(fx.app, {
        method: "DELETE",
        url: "/api/account",
        bearer: peer.bearer,
        payload: { confirmation: "DELETE MY ACCOUNT" },
      });
      expect(deleted.statusCode).toBe(200);
      expect(JSON.parse(deleted.body)).toMatchObject({
        ok: true,
        logtoRevoked: true,
        reconciliationPending: false,
      });

      const remaining = await fx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, peer.userId));
      expect(remaining).toHaveLength(0);
      expect(await fx.db.select({ id: rooms.id }).from(rooms)
        .where(eq(rooms.id, roomId))).toHaveLength(0);
      expect(await fx.db.select({ id: namespaces.id }).from(namespaces)
        .where(eq(namespaces.id, peerNamespace.id))).toHaveLength(0);
      expect(await fx.db.select({ userId: profiles.userId }).from(profiles)
        .where(eq(profiles.userId, peer.userId))).toHaveLength(0);
      expect(await fx.db.select({ userId: groupMembers.userId }).from(groupMembers)
        .where(eq(groupMembers.userId, peer.userId))).toHaveLength(0);
      expect(revokedLogtoUserIds).toEqual([peerUser.externalId]);

      const blocked = await authedInject(fx.app, {
        method: "GET",
        url: "/api/auth/whoami",
        bearer: peer.bearer,
      });
      expect(blocked.statusCode).toBe(200);
      expect(JSON.parse(blocked.body)).toMatchObject({ sessionUserId: null });
      peerUserId = null;
      peerRoomId = null;
      peerNamespaceId = null;
    } finally {
      _resetLogtoAdminClientForTests();
      if (peerRoomId) {
        await fx.db.delete(rooms).where(eq(rooms.id, peerRoomId));
      }
      if (peerNamespaceId) {
        await fx.db.delete(namespaces).where(eq(namespaces.id, peerNamespaceId));
      }
      if (peerUserId) {
        await fx.db.delete(profiles).where(eq(profiles.userId, peerUserId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      await fx.cleanup();
    }
  }, 60000);

  test("commits Nautilo deletion when Logto revoke fails and returns exact repair truth", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d518delfail" });
    let peerUserId: string | null = null;
    try {
      const ownerBearer = await fx.mintOwnerBearer();
      const peer = await seatPeerUser(fx.db, {
        suiteName: "d518delfail",
        groupType: "members",
      });
      peerUserId = peer.userId;
      _setLogtoAdminClientForTests({
        isUserActive: () => Promise.resolve(true),
        deleteUser: () => Promise.reject(new Error("UPSTREAM-SECRET-CANARY")),
      } as unknown as LogtoAdminClient);

      const deleted = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/admin/users/${peer.userId}`,
        bearer: ownerBearer,
      });

      expect(deleted.statusCode).toBe(200);
      expect(JSON.parse(deleted.body)).toMatchObject({
        ok: true,
        logtoRevoked: false,
        mutation: {
          stateChanged: true,
          retrySafe: false,
          receiptId: peer.userId,
          recovery: [{ kind: "reconcile_logto_user", userId: peer.userId }],
        },
      });
      expect(deleted.body).not.toContain("UPSTREAM-SECRET-CANARY");
      const remaining = await fx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, peer.userId));
      expect(remaining).toHaveLength(0);
      peerUserId = null;
    } finally {
      _resetLogtoAdminClientForTests();
      if (peerUserId) {
        await fx.db.delete(profiles).where(eq(profiles.userId, peerUserId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      await fx.cleanup();
    }
  }, 60000);

  test(
    "delete removes the account + cascades, with last-owner and federated guards",
    async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d220del" });
    let peerUserId: string | null = null;
    let federatedUserId: string | null = null;
    try {
      const ownerBearer = await fx.mintOwnerBearer();
      const peer = await seatPeerUser(fx.db, {
        suiteName: "d220del",
        groupType: "members",
      });
      peerUserId = peer.userId;

      // Happy path: delete the seated peer.
      const deleted = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/admin/users/${peer.userId}`,
        bearer: ownerBearer,
      });
      expect(deleted.statusCode).toBe(200);
      expect(JSON.parse(deleted.body)).toMatchObject({
        ok: true,
        logtoRevoked: true,
        mutation: {
          stateChanged: true,
          retrySafe: false,
          receiptId: peer.userId,
        },
      });

      // User row is gone…
      const remaining = await fx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, peer.userId));
      expect(remaining.length).toBe(0);
      // …and the NO-ACTION dependents we delete explicitly are gone…
      const remainingProfiles = await fx.db
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(eq(profiles.userId, peer.userId));
      expect(remainingProfiles.length).toBe(0);
      // …and the cascade FK (group_members) cleaned itself.
      const remainingMemberships = await fx.db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.userId, peer.userId));
      expect(remainingMemberships.length).toBe(0);
      peerUserId = null; // already deleted; skip finally cleanup

      // The deleted user's bearer no longer resolves to an authenticated
      // Nautilo user; `whoami` returns the anonymous envelope.
      const blocked = await authedInject(fx.app, {
        method: "GET",
        url: "/api/auth/whoami",
        bearer: peer.bearer,
      });
      expect(blocked.statusCode).toBe(200);
      const blockedBody = JSON.parse(blocked.body) as { sessionUserId?: string | null };
      expect(blockedBody.sessionUserId).toBeNull();

      // Unknown user → 404.
      const notFound = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/admin/users/00000000-0000-4000-8000-000000000000`,
        bearer: ownerBearer,
      });
      expect(notFound.statusCode).toBe(404);

      // Last-owner guard (branch on real owners-group membership, like the
      // soft-delete suite: a shared instance may already have other owners).
      const [ownersGroup] = await fx.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      const ownerMembers = ownersGroup
        ? await fx.db
            .select({ userId: groupMembers.userId })
            .from(groupMembers)
            .where(eq(groupMembers.groupId, ownersGroup.id))
        : [];
      const otherOwners = ownerMembers.filter((r) => r.userId !== fx.ownerId);
      if (otherOwners.length === 0) {
        const lastOwner = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/admin/users/${fx.ownerId}`,
          bearer: ownerBearer,
        });
        expect(lastOwner.statusCode).toBe(409);
        expect((JSON.parse(lastOwner.body) as { code?: string }).code).toBe(
          "last_owner",
        );
      }

      // Federated user → 422 (managed on home server).
      const [federated] = await fx.db
        .insert(users)
        .values({
          name: "Remote User",
          email: "d220del-remote@test.local",
          handle: `d220delfed${Date.now().toString(36)}`,
          server: "remote.example",
        })
        .returning({ id: users.id });
      federatedUserId = federated?.id ?? null;
      const federatedDelete = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/admin/users/${federatedUserId}`,
        bearer: ownerBearer,
      });
      expect(federatedDelete.statusCode).toBe(422);
      expect(
        (JSON.parse(federatedDelete.body) as { code?: string }).code,
      ).toBe("federated_user");
    } finally {
      if (peerUserId) {
        await fx.db.delete(profiles).where(eq(profiles.userId, peerUserId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      if (federatedUserId) {
        await fx.db.delete(users).where(eq(users.id, federatedUserId));
      }
      await fx.cleanup();
    }
  },
    60000,
  );
});

describe("admin users hard delete — D418 system-managed Group safety", () => {
  test(
    "hard-deleting the bootstrap owner does not cascade the six canonical ladder Groups or other canonical members",
    async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d418del" });
    let peerOwnerId: string | null = null;
    let peerMemberId: string | null = null;
    try {
      const ownerBearer = await fx.mintOwnerBearer();

      // Seat a SECOND owner so the bootstrap owner is not the last owner
      // (ownership transfer) — this is what unblocks the hard-delete.
      const peerOwner = await seatPeerUser(fx.db, { suiteName: "d418del", groupType: "owners" });
      peerOwnerId = peerOwner.userId;
      // Seat a separate member-rung peer to prove another canonical
      // member survives the bootstrap-owner hard-delete (only the deleted
      // user's own memberships are removed).
      const peerMember = await seatPeerUser(fx.db, { suiteName: "d418m", groupType: "members" });
      peerMemberId = peerMember.userId;

      // Snapshot the canonical state BEFORE the hard-delete: the six
      // canonical ladder Groups are system-managed (is_system=true,
      // owner_id NULL). Query by canonical type (not a blanket
      // is_system count) so the assertion is precise against the six
      // ladder Groups the policy protects, and immune to any orphan
      // rows left on already-migrated scratch DBs.
      const canonicalBefore = await fx.db
        .select({ type: groups.type, isSystem: groups.isSystem, ownerId: groups.ownerId })
        .from(groups)
        .where(inArray(groups.type, [...CANONICAL_LADDER_GROUP_TYPES]));
      expect(canonicalBefore.length).toBe(6);

      // Hard-delete the bootstrap owner (allowed: peerOwner is also an owner).
      const deleted = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/admin/users/${fx.ownerId}`,
        bearer: ownerBearer,
      });
      expect(deleted.statusCode).toBe(200);
      expect((JSON.parse(deleted.body) as { ok?: boolean }).ok).toBe(true);

      // The bootstrap owner row is gone.
      const ownerLeft = await fx.db.select({ id: users.id }).from(users).where(eq(users.id, fx.ownerId));
      expect(ownerLeft.length).toBe(0);

      // All six canonical ladder Groups survive (no cascade) and remain
      // is_system=true / owner_id NULL. Queried by canonical type so the
      // proof is about the six ladder Groups, not a blanket is_system
      // count that would also sweep any orphan rows on an
      // already-migrated scratch DB.
      const canonicalAfter = await fx.db
        .select({ type: groups.type, isSystem: groups.isSystem, ownerId: groups.ownerId })
        .from(groups)
        .where(inArray(groups.type, [...CANONICAL_LADDER_GROUP_TYPES]));
      expect(canonicalAfter.length).toBe(6);
      for (const g of canonicalAfter) {
        expect(g.isSystem).toBe(true);
        expect(g.ownerId).toBeNull();
      }

      // The peer owner (other canonical member) survives in the owners
      // ladder Group — only the deleted user's own memberships are removed.
      const [ownersGroup] = await fx.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      const peerOwnerMembership = await fx.db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, ownersGroup!.id), eq(groupMembers.userId, peerOwner.userId)));
      expect(peerOwnerMembership.length).toBe(1);

      // The member-rung peer also survives in the members ladder Group.
      // `group_members.granted_by` is ON DELETE SET NULL, so a membership
      // granted_by the bootstrap owner's actor stays (granted_by → NULL)
      // rather than cascading away — other canonical members are NOT
      // collateral damage of a bootstrap-owner hard-delete.
      const [membersGroup] = await fx.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "members"))
        .limit(1);
      const peerMemberMembership = await fx.db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, membersGroup!.id), eq(groupMembers.userId, peerMember.userId)));
      expect(peerMemberMembership.length).toBe(1);
    } finally {
      for (const pid of [peerOwnerId, peerMemberId]) {
        if (pid) {
          await fx.db.delete(groupMembers).where(eq(groupMembers.userId, pid));
          await fx.db.delete(profiles).where(eq(profiles.userId, pid));
          await fx.db.delete(users).where(eq(users.id, pid));
        }
      }
      await fx.cleanup();
    }
  },
    60000,
  );
});
