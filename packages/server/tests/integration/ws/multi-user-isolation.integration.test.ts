import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import { eventBus } from "@nautilo/runtime";
import { hashPin, setBootstrapDefaultAgentId } from "@nautilo/trust";
import { composeFederatedId, getServerHostname } from "@nautilo/config";
import {
  users,
  actors,
  credentials,
  channelIdentities,
  namespaces,
  rooms,
  roomMembers,
  agents,
  groups,
  groupMembers,
  roles,
  eq,
} from "@nautilo/db";
import { setupOwnerAppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";

describe("/ws multi-user lane isolation (integration)", () => {
  test("tool.start for room A is not delivered to a socket subscribed only to room B", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "wsmuiso" });
    try {
      const [ownerRole] = await fx.db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.slug, "owner"))
        .limit(1);
      if (!ownerRole) throw new Error("role");

      const [ag] = await fx.db
        .insert(agents)
        .values({ handle: `wsmu-ag-${Date.now().toString(36).slice(-6)}` })
        .returning({ id: agents.id });
      if (!ag) throw new Error("agent");

      // M128 — per-Agent ownership groups retired; the fixture's
      // canonical `owners` Group is already seeded by seedTrustPersonal.
      // Just ensure the fixture's owner is a member.
      const [og] = await fx.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      if (!og) throw new Error("owners group missing");
      await fx.db
        .insert(groupMembers)
        .values({
          groupId: og.id,
          userId: fx.ownerId,
          grantedBy: fx.ownerActorId,
        })
        .onConflictDoNothing({
          target: [groupMembers.groupId, groupMembers.userId],
        });
      void ownerRole;

      const [agentActor] = await fx.db
        .insert(actors)
        .values({
          ownerId: fx.ownerId,
          displayName: "agent",
          trustState: "verified",
          kind: "agent",
          agentId: ag.id,
        })
        .returning({ id: actors.id });
      if (!agentActor) throw new Error("aa");

      const [nsA] = await fx.db
        .insert(namespaces)
        .values({ scope: "private", label: "a" })
        .returning({ id: namespaces.id });
      const [nsB] = await fx.db
        .insert(namespaces)
        .values({ scope: "private", label: "b" })
        .returning({ id: namespaces.id });
      if (!nsA || !nsB) throw new Error("ns");

      const [roomA] = await fx.db
        .insert(rooms)
        .values({
          ownerId: fx.ownerId,
          type: "private",
          label: "RA",
          graphThreadId: "app:default",
          namespaceId: nsA.id,
          humanActorIds: [fx.ownerActorId],
          createdBy: fx.ownerActorId,
        })
        .returning({ id: rooms.id });
      const [roomB] = await fx.db
        .insert(rooms)
        .values({
          ownerId: fx.ownerId,
          type: "private",
          label: "RB",
          graphThreadId: "app:default",
          namespaceId: nsB.id,
          humanActorIds: [fx.ownerActorId],
          createdBy: fx.ownerActorId,
        })
        .returning({ id: rooms.id });
      if (!roomA || !roomB) throw new Error("rooms");

      await fx.db.update(rooms).set({ graphThreadId: `room:${roomA.id}` }).where(eq(rooms.id, roomA.id));
      await fx.db.update(rooms).set({ graphThreadId: `room:${roomB.id}` }).where(eq(rooms.id, roomB.id));

      await fx.db.insert(roomMembers).values([
        { roomId: roomA.id, actorId: fx.ownerActorId, roomRole: "admin" },
        { roomId: roomA.id, actorId: agentActor.id, roomRole: "member" },
        { roomId: roomB.id, actorId: fx.ownerActorId, roomRole: "admin" },
        { roomId: roomB.id, actorId: agentActor.id, roomRole: "member" },
      ]);

      const peerPin = "918273";
      const peerHandle = `wsmub${Date.now().toString(36).slice(-8)}`;
      const [u] = await fx.db
        .insert(users)
        .values({
          name: "wsmu-b",
          email: `wsmu-b-${Date.now()}@test.local`,
          handle: peerHandle,
          externalId: randomUUID(),
        })
        .returning({ id: users.id });
      if (!u) throw new Error("u");
      const [peerActor] = await fx.db
        .insert(actors)
        .values({
          ownerId: u.id,
          displayName: "B",
          trustState: "verified",
          kind: "user",
        })
        .returning({ id: actors.id });
      if (!peerActor) throw new Error("pa");
      await fx.db.insert(credentials).values({
        userId: u.id,
        type: "pin",
        value: await hashPin(peerPin),
      });
      const peerFed = composeFederatedId(peerHandle, getServerHostname());
      await fx.db.insert(channelIdentities).values([
        { channel: "tui", externalId: peerFed, userId: u.id, verifiedAt: new Date() },
        { channel: "workbench", externalId: peerFed, userId: u.id, verifiedAt: new Date() },
      ]);
      await fx.db.insert(groupMembers).values({
        groupId: og.id,
        userId: u.id,
        grantedBy: fx.ownerActorId,
      });
      await fx.db.insert(roomMembers).values({
        roomId: roomB.id,
        actorId: peerActor.id,
        roomRole: "member",
      });

      setBootstrapDefaultAgentId(ag.id);

      await withListeningServer(fx.app, async (base) => {
        const url = httpBaseToWsUrl(base, "/ws");
        const tOwner = await fx.mintOwnerBearer();
        const tB = await fx.mintSessionBearerForUser(peerActor.id, u.id);
        const cOwner = await connectWsTestClient({ url, token: tOwner });
        const cB = await connectWsTestClient({ url, token: tB });

        const laneA = `room:${roomA.id}`;
        const toolCallId = `tc-${Date.now()}`;
        eventBus.emit({
          type: "tool.start",
          laneKey: laneA,
          toolCallId,
          toolName: "noop",
        });
        await new Promise((r) => setTimeout(r, 30));

        const pred = (e: unknown): e is { type: string; toolCallId?: string } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "tool.start" &&
          (e as { toolCallId?: string }).toolCallId === toolCallId;

        const ownerEv = await cOwner.waitForEvent(pred, 5_000);
        expect(ownerEv).toMatchObject({ type: "tool.start" });

        let peerTimedOut = false;
        try {
          await cB.waitForEvent(pred, 600);
        } catch (e) {
          peerTimedOut = e instanceof Error && /timed out/i.test(e.message);
        }
        expect(peerTimedOut).toBe(true);

        await cOwner.close();
        await cB.close();
      });

      await fx.db.delete(roomMembers).where(eq(roomMembers.actorId, peerActor.id));
      await fx.db.delete(groupMembers).where(eq(groupMembers.userId, u.id));
      await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, u.id));
      await fx.db.delete(credentials).where(eq(credentials.userId, u.id));
      await fx.db.delete(actors).where(eq(actors.ownerId, u.id));
      await fx.db.delete(users).where(eq(users.id, u.id));
      await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, roomA.id));
      await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, roomB.id));
      await fx.db.delete(rooms).where(eq(rooms.id, roomA.id));
      await fx.db.delete(rooms).where(eq(rooms.id, roomB.id));
      await fx.db.delete(namespaces).where(eq(namespaces.id, nsA.id));
      await fx.db.delete(namespaces).where(eq(namespaces.id, nsB.id));
      await fx.db.delete(actors).where(eq(actors.id, agentActor.id));
      // M128 — `og` is the CANONICAL server-wide `owners` Group seeded by
      // seedTrustPersonal (selected by type above), NOT a per-Agent group
      // this test created. Deleting it (or wholesale-clearing its members)
      // damages the database for every other user. This test
      // only ADDED `fx.ownerId` as a member (onConflictDoNothing above), and
      // `fx.cleanup()` already removes that one membership row. So there is
      // nothing for this block to undo — never DELETE the canonical Group.
      await fx.db.delete(agents).where(eq(agents.id, ag.id));
    } finally {
      setBootstrapDefaultAgentId("");
      await fx.cleanup();
    }
  });
});
