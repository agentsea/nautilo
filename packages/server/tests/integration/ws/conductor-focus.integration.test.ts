import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../../.env") });

import { describe, test, expect } from "bun:test";
import {
  createMaintenanceAcceptanceAuthority,
  eventBus,
  notifyRedirectCompletion,
  turnContextKey,
} from "@nautilo/runtime";
import {
  actors,
  agents,
  namespaces,
  rooms,
  roomMembers,
  focusEvents,
  eq,
  and,
} from "@nautilo/db";
import {
  openOrExtendFocus,
  clearFocus,
  loadActiveFoci,
  materializeExpiry,
} from "@nautilo/trust";
import { setupOwnerAppFixture, type AppFixture } from "../helpers/app-fixture";
import { withListeningServer } from "../helpers/request-helpers";
import { connectWsTestClient, httpBaseToWsUrl } from "./helpers/ws-test-client";
import {
  pendingAgentRedirectCount,
  registerPendingAgentRedirect,
  type PendingAgentRedirectContext,
} from "../../../src/messaging/agent-redirect-handler";

const FOCUS_TTL_MS = 90_000;

/**
 * Seeds a GROUP room (1 human owner + 2 agents) on the connected DB and
 * returns the ids. Caller cleans up via the returned `teardown`.
 */
async function seedGroupRoom(fx: AppFixture, tag: string) {
  const db = fx.db;
  const mk = (s: string) => `${tag}-${s}-${Date.now().toString(36).slice(-6)}`;

  const [agA] = await db
    .insert(agents)
    .values({ handle: mk("nova") })
    .returning({ id: agents.id });
  const [agB] = await db
    .insert(agents)
    .values({ handle: mk("alepo") })
    .returning({ id: agents.id });
  if (!agA || !agB) throw new Error("agents");

  const [actorA] = await db
    .insert(actors)
    .values({ ownerId: fx.ownerId, displayName: "Nova", trustState: "verified", kind: "agent", agentId: agA.id })
    .returning({ id: actors.id });
  const [actorB] = await db
    .insert(actors)
    .values({ ownerId: fx.ownerId, displayName: "Alepo", trustState: "verified", kind: "agent", agentId: agB.id })
    .returning({ id: actors.id });
  if (!actorA || !actorB) throw new Error("agent actors");

  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "private", label: tag })
    .returning({ id: namespaces.id });
  if (!ns) throw new Error("ns");

  const [room] = await db
    .insert(rooms)
    .values({
      ownerId: fx.ownerId,
      type: "private",
      label: `${tag} room`,
      graphThreadId: "tmp",
      namespaceId: ns.id,
      humanActorIds: [fx.ownerActorId],
      createdBy: fx.ownerActorId,
    })
    .returning({ id: rooms.id });
  if (!room) throw new Error("room");
  await db.update(rooms).set({ graphThreadId: `room:${room.id}` }).where(eq(rooms.id, room.id));

  await db.insert(roomMembers).values([
    { roomId: room.id, actorId: fx.ownerActorId, roomRole: "admin" },
    { roomId: room.id, actorId: actorA.id, roomRole: "member", agentResponseMode: "active" },
    { roomId: room.id, actorId: actorB.id, roomRole: "member", agentResponseMode: "active" },
  ]);

  const teardown = async () => {
    await db.delete(focusEvents).where(eq(focusEvents.roomId, room.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, room.id));
    await db.delete(rooms).where(eq(rooms.id, room.id));
    await db.delete(namespaces).where(eq(namespaces.id, ns.id));
    await db.delete(actors).where(eq(actors.id, actorA.id));
    await db.delete(actors).where(eq(actors.id, actorB.id));
    await db.delete(agents).where(eq(agents.id, agA.id));
    await db.delete(agents).where(eq(agents.id, agB.id));
  };

  return { roomId: room.id, botA: actorA.id, botB: actorB.id, teardown };
}

describe("M134 focus store (integration, Postgres)", () => {
  test("open → active; extend pushes TTL; second bot → two foci; clear → one; lazy expiry materialized", async () => {
    const fx = await setupOwnerAppFixture({
      suiteName: `m134f${Date.now().toString(36).slice(-7)}`,
    });
    const { roomId, botA, botB, teardown } = await seedGroupRoom(fx, "focus");
    const user = fx.ownerActorId;
    try {
      const t0 = new Date("2026-06-02T12:00:00.000Z");

      // open A
      const openA = await openOrExtendFocus(fx.db, {
        roomId, userActorId: user, botActorId: botA, source: "mention", now: t0,
      });
      let active = await loadActiveFoci(fx.db, roomId, user, t0);
      expect(active.map((f) => f.botActorId)).toEqual([botA]);

      // extend A (later) reuses focusId + pushes expiresAt
      const t1 = new Date(t0.getTime() + 30_000);
      const extA = await openOrExtendFocus(fx.db, {
        roomId, userActorId: user, botActorId: botA, source: "inferred", now: t1,
      });
      expect(extA.focusId).toBe(openA.focusId);
      active = await loadActiveFoci(fx.db, roomId, user, t1);
      expect(active).toHaveLength(1);
      expect(active[0]!.expiresAt.getTime()).toBe(t1.getTime() + FOCUS_TTL_MS);

      // open B → two active
      await openOrExtendFocus(fx.db, {
        roomId, userActorId: user, botActorId: botB, source: "mention", now: t1,
      });
      active = await loadActiveFoci(fx.db, roomId, user, t1);
      expect(new Set(active.map((f) => f.botActorId))).toEqual(new Set([botA, botB]));

      // clear A → one active (B)
      await clearFocus(fx.db, { roomId, userActorId: user, focusId: openA.focusId, now: t1 });
      active = await loadActiveFoci(fx.db, roomId, user, t1);
      expect(active.map((f) => f.botActorId)).toEqual([botB]);

      // lazy expiry: read far in the future → B inactive AND an `expired` row written
      const future = new Date(t1.getTime() + FOCUS_TTL_MS + 5_000);
      active = await loadActiveFoci(fx.db, roomId, user, future);
      expect(active).toHaveLength(0);
      const expiredRows = await fx.db
        .select({ id: focusEvents.id })
        .from(focusEvents)
        .where(and(eq(focusEvents.roomId, roomId), eq(focusEvents.eventType, "expired")));
      expect(expiredRows.length).toBeGreaterThanOrEqual(1);

      // clearing wins: materializeExpiry must NOT write for the cleared focus A
      const beforeCount = (
        await fx.db.select({ id: focusEvents.id }).from(focusEvents).where(eq(focusEvents.focusId, openA.focusId))
      ).length;
      await materializeExpiry(fx.db, {
        roomId, userActorId: user, botActorId: botA, focusId: openA.focusId,
        lapsedExpiresAt: new Date(t0.getTime() + FOCUS_TTL_MS), now: future,
      });
      const afterCount = (
        await fx.db.select({ id: focusEvents.id }).from(focusEvents).where(eq(focusEvents.focusId, openA.focusId))
      ).length;
      expect(afterCount).toBe(beforeCount); // no new row — cleared wins
    } finally {
      await teardown();
      await fx.cleanup();
    }
  });
});

describe("D421 redirect focus transfer (integration, Postgres)", () => {
  test("successful target enqueue clears source focus and opens target focus", async () => {
    const fx = await setupOwnerAppFixture({
      suiteName: `d421${Date.now().toString(36).slice(-7)}`,
    });
    const { roomId, botA, botB, teardown } = await seedGroupRoom(
      fx,
      "redirect-focus",
    );
    const [sourceRow] = await fx.db
      .select({ agentId: actors.agentId })
      .from(actors)
      .where(eq(actors.id, botA))
      .limit(1);
    const [targetRow] = await fx.db
      .select({ agentId: actors.agentId })
      .from(actors)
      .where(eq(actors.id, botB))
      .limit(1);
    const sourceAgentId = sourceRow?.agentId ?? "";
    const targetAgentId = targetRow?.agentId ?? "";
    const turnId = `d421-focus-${Date.now()}`;
    const emitted: unknown[] = [];
    const handler = (event: unknown) => emitted.push(event);
    eventBus.on(handler);
    try {
      await openOrExtendFocus(fx.db, {
        roomId,
        userActorId: fx.ownerActorId,
        botActorId: botA,
        source: "inferred",
        reason: "source wake",
        now: new Date(),
      });
      const context = {
        roomId,
        senderActorId: fx.ownerActorId,
        senderUserId: fx.ownerId,
        sourceAgentId,
        sourceAgentActorId: botA,
        sourceHandle: "source",
        persistedMessageId: 42,
        humanTurnId: turnId,
        acceptanceAuthority: createMaintenanceAcceptanceAuthority(),
        redirectAllowed: true,
        sourceRedirectDepth: 0,
        sourceWakeReady: Promise.resolve(true),
        original: {
          content: "redirect me",
          voiceMode: false,
          currentFolder: null,
          workspacePath: null,
          activeMiniApp: null,
          liveMiniAppSession: null,
          attachmentRefs: [],
          artifactRefs: [],
          focusedResources: [],
          model: null,
          transcriptOwnerId: fx.ownerId,
          canonicalMemoryAccessEnvelope: {},
        },
        loadLiveMembers: () =>
          Promise.resolve([
            {
              kind: "agent" as const,
              actorId: botA,
              agentId: sourceAgentId,
              handle: "source",
              agentResponseMode: "active" as const,
            },
            {
              kind: "agent" as const,
              actorId: botB,
              agentId: targetAgentId,
              handle: "target",
              agentResponseMode: "active" as const,
            },
          ]),
        loadActiveSilence: () => Promise.resolve([]),
        enqueueTarget: () => Promise.resolve(),
      } as unknown as PendingAgentRedirectContext;
      registerPendingAgentRedirect(
        turnContextKey(turnId, sourceAgentId),
        context,
      );
      await notifyRedirectCompletion({
        kind: "fulfilled",
        turnContextId: turnContextKey(turnId, sourceAgentId),
        humanTurnId: turnId,
        sourceAgentId,
        request: { targetHandle: "target", depth: 1 },
      });

      const active = await loadActiveFoci(
        fx.db,
        roomId,
        fx.ownerActorId,
        new Date(),
      );
      expect(active.map((focus) => focus.botActorId)).toEqual([botB]);
      expect(pendingAgentRedirectCount()).toBe(0);
      expect(
        emitted.filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            (event as { type?: unknown }).type === "conductor.focus_changed",
        ),
      ).toHaveLength(2);
    } finally {
      eventBus.off(handler);
      await teardown();
      await fx.cleanup();
    }
  });
});

describe("M134 WS delivery regression (integration)", () => {
  test("events on the per-(user,bot) group lane are delivered to a room subscriber", async () => {
    const fx = await setupOwnerAppFixture({
      suiteName: `m134w${Date.now().toString(36).slice(-7)}`,
    });
    const { roomId, botA, teardown } = await seedGroupRoom(fx, "wsdeliv");
    // botA's agent id (the lane key uses agentId, not actorId)
    const [agentRow] = await fx.db
      .select({ agentId: actors.agentId })
      .from(actors)
      .where(eq(actors.id, botA))
      .limit(1);
    const agentId = agentRow?.agentId ?? "";
    try {
      await withListeningServer(fx.app, async (base) => {
        const url = httpBaseToWsUrl(base, "/ws");
        const token = await fx.mintOwnerBearer();
        const owner = await connectWsTestClient({ url, token });

        const isMsgNew = (id: string) => (e: unknown): e is { type: string; messageId?: string } =>
          typeof e === "object" && e !== null &&
          (e as { type?: string }).type === "message.new" &&
          (e as { messageId?: string }).messageId === id;

        // 1) per-(user,bot) group lane — the exact shape that regressed.
        const botLaneMsgId = `m134-bot-${Date.now()}`;
        eventBus.emit({
          type: "message.new",
          laneKey: `room:${roomId}:user:${fx.ownerActorId}:bot:${agentId}`,
          messageId: botLaneMsgId,
          role: "ai",
          content: "hi from bot",
          sourceUserId: fx.ownerId,
          senderUserId: fx.ownerId,
        });
        const got = await owner.waitForEvent(isMsgNew(botLaneMsgId), 5_000);
        expect(got).toMatchObject({ type: "message.new", messageId: botLaneMsgId });

        // 2) legacy bare room lane still delivers (sanity).
        const bareMsgId = `m134-bare-${Date.now()}`;
        eventBus.emit({
          type: "message.new",
          laneKey: `room:${roomId}`,
          messageId: bareMsgId,
          role: "ai",
          content: "hi bare",
          sourceUserId: fx.ownerId,
          senderUserId: fx.ownerId,
        });
        const got2 = await owner.waitForEvent(isMsgNew(bareMsgId), 5_000);
        expect(got2).toMatchObject({ type: "message.new", messageId: bareMsgId });

        await owner.close();
      });
    } finally {
      await teardown();
      await fx.cleanup();
    }
  });
});
