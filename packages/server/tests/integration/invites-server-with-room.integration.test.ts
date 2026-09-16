import { randomUUID } from "node:crypto";
import { completeInviteProfile, redeemInviteWithLogtoSub } from "../../src/lib/redeem-invite";
import type { CommittedHumanMembershipChange } from "../../src/event-feed/membership-producer";
/**
 * M128 T17 — server invite optional targetRoomId on redeem.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  eq,
  and,
  actors,
  groupMembers,
  groups,
  roomMembers,
  rooms,
  invites,
} from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import {
  redeemServerInviteToken,
  cleanupInvitee,
} from "./helpers/invite-redeem-helpers";

describe("POST /api/invites — server invite room pointer (T17)", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({
      suiteName: "m128t17",
      withDefaultAgentGraph: true,
    });
    bearer = await fx.mintOwnerBearer();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("targetRoomId adds room_members and sets landingRoomId", async () => {
    const targetRoomId = fx.defaultRoomId;
    if (!targetRoomId) throw new Error("fixture room missing");

    const mintRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "member",
        targetRoomId,
      },
    });
    expect(mintRes.statusCode).toBe(200);
    const { token } = JSON.parse(mintRes.body) as { token: string };

    const handle = `t17room${Date.now().toString(36).slice(-6)}`;
    let committedCallback = false;
    const redeem = await redeemServerInviteToken(token, handle, {
      onHumanRoomJoined: async (change) => {
        const member = await fx.db.select({ actorId: roomMembers.actorId }).from(roomMembers)
          .where(and(eq(roomMembers.roomId, targetRoomId), eq(roomMembers.actorId, change.initiatorActorId)));
        expect(member).toHaveLength(1);
        committedCallback = true;
        throw new Error("simulated observer failure after commit");
      },
    });
    expect(committedCallback).toBe(true);
    expect(redeem.ok).toBe(true);
    if (!redeem.ok) return;

    const [membersGroup] = await fx.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "members"))
      .limit(1);
    expect(membersGroup).toBeDefined();

    const [gm] = await fx.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.userId, redeem.newUserId), eq(groupMembers.groupId, membersGroup!.id)),
      )
      .limit(1);
    expect(gm).toBeDefined();

    const [rm] = await fx.db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .innerJoin(actors, eq(roomMembers.actorId, actors.id))
      .where(and(eq(actors.ownerId, redeem.newUserId), eq(roomMembers.roomId, targetRoomId)))
      .limit(1);
    expect(rm).toBeDefined();
    expect(redeem.landingRoomId).toBe(targetRoomId);

    await cleanupInvitee(fx, redeem.newUserId);
  });

  test("split signup emits only after completion and never again on replay", async () => {
    const targetRoomId = fx.defaultRoomId!;
    const minted = await authedInject(fx.app, { method: "POST", url: "/api/invites", bearer,
      payload: { kind: "server", targetGroupRoleSlug: "member", targetRoomId } });
    expect(minted.statusCode).toBe(200);
    const { token, id } = JSON.parse(minted.body) as { token: string; id: string };
    const sub = randomUUID();
    const handle = `m323split${Date.now().toString(36).slice(-7)}`;
    const changes: CommittedHumanMembershipChange[] = [];
    const deps = { onHumanRoomJoined: (change: CommittedHumanMembershipChange) => { changes.push(change); } };
    const bound = await redeemInviteWithLogtoSub(token, sub, { handle, displayName: "Invited member" }, deps);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    try {
      expect(changes).toHaveLength(0);
      const completed = await completeInviteProfile(token, sub, { displayName: "Invited member", pin: "847291" }, deps);
      expect(completed.ok).toBe(true);
      expect(changes).toEqual([{ type: "room.member_joined", roomId: targetRoomId,
        subjectUserId: bound.userId, initiatorUserId: bound.userId, initiatorActorId: bound.actorId,
        membershipOccurrenceId: `invite-redemption:${id}:${bound.userId}` }]);
      const replay = await completeInviteProfile(token, sub, { displayName: "Invited member", pin: "847291" }, deps);
      expect(replay.ok).toBe(true);
      expect(changes).toHaveLength(1);
    } finally { await cleanupInvitee(fx, bound.userId); }
  });

  test("without targetRoomId returns and joins a non-personal server landing Room", async () => {
    const mintRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "server", targetGroupRoleSlug: "member" },
    });
    expect(mintRes.statusCode).toBe(200);
    const { token } = JSON.parse(mintRes.body) as { token: string };

    const handle = `t17noroom${Date.now().toString(36).slice(-6)}`;
    const redeem = await redeemServerInviteToken(token, handle);
    expect(redeem.ok).toBe(true);
    if (!redeem.ok) return;

    const [landingMembership] = await fx.db
      .select({ roomId: roomMembers.roomId, ownerId: rooms.ownerId })
      .from(roomMembers)
      .innerJoin(actors, eq(roomMembers.actorId, actors.id))
      .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
      .where(
        and(
          eq(actors.ownerId, redeem.newUserId),
          eq(roomMembers.roomId, redeem.landingRoomId),
        ),
      )
      .limit(1);
    expect(landingMembership?.roomId).toBe(redeem.landingRoomId);
    expect(landingMembership?.ownerId).not.toBe(redeem.newUserId);

    await cleanupInvitee(fx, redeem.newUserId);
  });

  test("an archived explicit Room fails without consuming the Invite", async () => {
    const targetRoomId = fx.defaultRoomId;
    if (!targetRoomId) throw new Error("fixture room missing");
    const mintRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "member",
        targetRoomId,
      },
    });
    expect(mintRes.statusCode).toBe(200);
    const minted = JSON.parse(mintRes.body) as { id: string; token: string };

    await fx.db
      .update(rooms)
      .set({ archivedAt: new Date() })
      .where(eq(rooms.id, targetRoomId));
    try {
      const redeem = await redeemServerInviteToken(
        minted.token,
        `t17archived${Date.now().toString(36).slice(-6)}`,
      );
      expect(redeem).toMatchObject({
        ok: false,
        code: "target_room_unavailable",
      });
      const [invite] = await fx.db
        .select({ usedCount: invites.usedCount })
        .from(invites)
        .where(eq(invites.id, minted.id))
        .limit(1);
      expect(invite?.usedCount).toBe(0);
    } finally {
      await fx.db
        .update(rooms)
        .set({ archivedAt: null })
        .where(eq(rooms.id, targetRoomId));
    }
  });
});
