/**
 * D468 Phase 2.8 — production-shaped important-message delivery proof.
 *
 * This test deliberately crosses the real canonical append, Postgres/RLS,
 * durable candidate, shared classifier, per-generation delivery, encryption,
 * and Expo adapter boundaries. No process-local event participates in the
 * proof: workers are constructed only after both message transactions commit.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  namespaces,
  pushInstallationBindings,
  pushMessageCandidates,
  pushNotificationDeliveries,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
  withTrustContext,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { appendCanonicalTranscriptRowsToExistingSessionInTx } from "@nautilo/trust";

import { ExpoPushProvider } from "../../src/push/expo-push-provider";
import { createPushDeliveryWorker } from "../../src/push/push-delivery-worker";
import { createPushInstallationStore } from "../../src/push/push-installation-store";

type Db = ReturnType<typeof createDirectDb>;

let db: Db;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  const relation = await db.execute(
    "SELECT to_regclass('public.push_notification_deliveries') AS relation",
  ) as unknown as Array<{ relation: string | null }>;
  if (!relation[0]?.relation) {
    throw new Error(
      "D468 integration environment blocker: migration 0150_smooth_juggernaut is not applied",
    );
  }
});

afterAll(async () => {
  await db?.end();
});

describe("D468 durable important-message delivery", () => {
  test("drains committed legacy and protected candidates exactly once across provider failure and worker restart", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const key = Buffer.alloc(32, 23);
    const plaintextToken = `ExponentPushToken[d468-phase-2-8-${suffix}]`;
    const legacyContent = `legacy-private-${randomUUID()}`;
    const protectedContent = `protected-private-${randomUUID()}`;
    const installationId = randomUUID();
    const bindingId = randomUUID();
    const roomId = randomUUID();
    let authorId = "";
    let viewerId = "";
    let authorActorId = "";
    let viewerActorId = "";
    let namespaceId = "";
    let agentId = "";
    let sessionId = "";
    let clock = new Date("2026-08-05T22:00:00.000Z");

    try {
      const [author] = await db.insert(users).values({
        name: "D468 important author",
        email: `d468-important-author-${suffix}@test.invalid`,
        handle: `d468importantauthor${suffix}`,
      }).returning({ id: users.id });
      const [viewer] = await db.insert(users).values({
        name: "D468 important viewer",
        email: `d468-important-viewer-${suffix}@test.invalid`,
        handle: `d468importantviewer${suffix}`,
      }).returning({ id: users.id });
      if (!author || !viewer) throw new Error("D468 Human fixtures were not created");
      authorId = author.id;
      viewerId = viewer.id;

      const [agent] = await db.insert(agents).values({ handle: `d468-${suffix}` })
        .returning({ id: agents.id });
      const [namespace] = await db.insert(namespaces).values({
        scope: "private",
        label: `d468-${suffix}`,
      }).returning({ id: namespaces.id });
      if (!agent || !namespace) throw new Error("D468 Room fixtures were not created");
      agentId = agent.id;
      namespaceId = namespace.id;

      const [authorActor] = await db.insert(actors).values({
        ownerId: authorId,
        displayName: "D468 author",
        kind: "user",
      }).returning({ id: actors.id });
      const [viewerActor] = await db.insert(actors).values({
        ownerId: viewerId,
        displayName: "D468 viewer",
        kind: "user",
      }).returning({ id: actors.id });
      if (!authorActor || !viewerActor) throw new Error("D468 actor fixtures were not created");
      authorActorId = authorActor.id;
      viewerActorId = viewerActor.id;

      await db.insert(rooms).values({
        id: roomId,
        ownerId: authorId,
        type: "group",
        kind: "group",
        label: `D468 important ${suffix}`,
        graphThreadId: `room:${roomId}`,
        namespaceId,
        humanActorIds: [authorActorId, viewerActorId],
      });
      await db.insert(roomMembers).values([
        { roomId, actorId: authorActorId, roomRole: "member" },
        { roomId, actorId: viewerActorId, roomRole: "member" },
      ]);
      const [session] = await db.insert(sessions).values({
        threadId: `room:${roomId}:${authorId.slice(0, 8)}`,
        ownerId: authorId,
        personaId: "owner",
        agentId,
        roomId,
        channel: "tui",
      }).returning({ id: sessions.id });
      if (!session) throw new Error("D468 Session fixture was not created");
      sessionId = session.id;

      const store = createPushInstallationStore({
        db,
        getEncryptionKey: () => key,
        now: () => clock,
      });
      await store.register({
        userId: viewerId,
        request: {
          version: 1,
          installationId,
          bindingId,
          platform: "ios",
          expoPushToken: plaintextToken,
          enabled: true,
          tokenGeneration: 1,
          appVersion: "0.1.0",
          permission: "granted",
          revokeProof: "r".repeat(48),
        },
      });

      // Both transactions commit before a worker exists. This is the crash
      // boundary: losing every in-memory/realtime event cannot lose push work.
      const legacy = await db.transaction((tx) =>
        appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
          sessionId,
          rows: [{
            role: "user",
            content: legacyContent,
            toolCalls: null,
            toolName: null,
            fingerprint: `d468-legacy-${randomUUID()}`,
            humanTurnId: `d468-turn-${randomUUID()}`,
            transcriptOrigin: "main",
            parentThreadId: null,
            scopeId: null,
            metadata: null,
            subthreadRoomId: null,
            replyToMessageId: null,
          }],
          notificationContext: {
            mentionedHumanUserIds: [viewerId],
            causalHumanUserId: null,
            causalHumanTurnId: null,
          },
        })
      );
      const protectedAppend = await db.transaction((tx) =>
        appendCanonicalTranscriptRowsToExistingSessionInTx(tx, {
          sessionId,
          rows: [{
            role: "user",
            content: protectedContent,
            toolCalls: null,
            toolName: null,
            fingerprint: `d468-protected-${randomUUID()}`,
            humanTurnId: `d468-turn-${randomUUID()}`,
            transcriptOrigin: "main",
            parentThreadId: null,
            scopeId: null,
            metadata: { source: "protected-product" },
            subthreadRoomId: null,
            replyToMessageId: null,
            protectedStructuralProjection: {
              notificationEligibility: "eligible",
              subthreadReplyClassification: "excluded",
            },
          }],
          notificationContext: {
            mentionedHumanUserIds: [viewerId],
            causalHumanUserId: null,
            causalHumanTurnId: null,
          },
        })
      );
      const messageIds = [
        Number(legacy.insertedRows[0]?.id),
        Number(protectedAppend.insertedRows[0]?.id),
      ];
      expect(messageIds.every((id) => Number.isSafeInteger(id) && id > 0)).toBe(true);

      const candidatesBeforeRestart = await db.select().from(pushMessageCandidates);
      expect(candidatesBeforeRestart.filter((row) => messageIds.includes(row.messageId)))
        .toHaveLength(2);
      for (const candidate of candidatesBeforeRestart.filter((row) => messageIds.includes(row.messageId))) {
        expect(candidate).toMatchObject({ state: "pending" });
        expect(JSON.stringify(candidate)).not.toContain(legacyContent);
        expect(JSON.stringify(candidate)).not.toContain(protectedContent);
        expect(JSON.stringify(candidate)).not.toContain(plaintextToken);
      }

      let sendCalls = 0;
      const observedWire: unknown[] = [];
      const provider = new ExpoPushProvider({
        fetch: async (url, init) => {
          if (!url.includes("/push/send")) {
            throw new Error("receipts are not due in this proof");
          }
          if (typeof init.body !== "string") throw new Error("Expo adapter must send JSON text");
          const wire = JSON.parse(init.body) as unknown;
          observedWire.push(wire);
          sendCalls += 1;
          if (sendCalls === 1) throw new Error("simulated provider outage");
          const deliveries = Array.isArray(wire) ? wire : [wire];
          return new Response(JSON.stringify({
            data: deliveries.map((_: unknown, index: number) => ({
              status: "ok",
              id: `ticket-d468-${sendCalls}-${index}`,
            })),
          }), { status: 200 });
        },
      });

      const firstWorker = createPushDeliveryWorker({
        db,
        workerId: `d468-phase-2-8-first-${suffix}`,
        provider,
        now: () => clock,
        getEncryptionKey: () => key,
      });
      const firstTurn = await firstWorker.runOnce();
      expect(firstTurn.candidatesProcessed).toBe(1);
      expect(firstTurn.sendsClaimed).toBe(1);

      const persistedAfterProviderFailure = await db
        .select({ id: sessionMessages.id, content: sessionMessages.content })
        .from(sessionMessages)
        .where(eq(sessionMessages.id, messageIds[0]!));
      expect(persistedAfterProviderFailure).toEqual([
        { id: messageIds[0]!, content: legacyContent },
      ]);

      // A fresh worker is the only process-local state after the simulated
      // outage. It drains the second durable candidate and sends it.
      const restartedWorker = createPushDeliveryWorker({
        db,
        workerId: `d468-phase-2-8-restarted-${suffix}`,
        provider,
        now: () => clock,
        getEncryptionKey: () => key,
      });
      const restartTurn = await restartedWorker.runOnce();
      expect(restartTurn.candidatesProcessed).toBe(1);
      expect(restartTurn.sendsClaimed).toBe(1);

      // Retry the first delivery after its bounded backoff, then run again to
      // prove terminal candidates/restarts cannot duplicate logical delivery.
      clock = new Date(clock.getTime() + 5_000);
      await restartedWorker.runOnce();
      await createPushDeliveryWorker({
        db,
        workerId: `d468-phase-2-8-duplicate-${suffix}`,
        provider,
        now: () => clock,
        getEncryptionKey: () => key,
      }).runOnce();

      const deliveries = await withTrustContext({ userId: viewerId }, (tx) =>
        tx.select().from(pushNotificationDeliveries)
          .where(eq(pushNotificationDeliveries.userId, viewerId)), db);
      const importantDeliveries = deliveries.filter(
        (delivery) => delivery.kind === "important_message"
          && messageIds.includes(delivery.messageId ?? -1),
      );
      expect(importantDeliveries).toHaveLength(2);
      expect(new Set(importantDeliveries.map((delivery) =>
        `${delivery.eventId}:${delivery.bindingId}:${delivery.tokenGeneration}`,
      )).size).toBe(2);
      expect(importantDeliveries.every((delivery) =>
        delivery.bindingId === bindingId
          && delivery.tokenGeneration === 1
          && delivery.state === "receipt_pending",
      )).toBe(true);

      const persistedEvidence = JSON.stringify({
        candidates: candidatesBeforeRestart.filter((row) => messageIds.includes(row.messageId)),
        deliveries: importantDeliveries,
      });
      expect(persistedEvidence).not.toContain(legacyContent);
      expect(persistedEvidence).not.toContain(protectedContent);
      expect(persistedEvidence).not.toContain(plaintextToken);
      const [binding] = await withTrustContext({ userId: viewerId }, (tx) =>
        tx.select().from(pushInstallationBindings)
          .where(eq(pushInstallationBindings.bindingId, bindingId)), db);
      expect(binding?.tokenCiphertextBase64).not.toContain(plaintextToken);

      const serializedWire = JSON.stringify(observedWire);
      expect(serializedWire).not.toContain(legacyContent);
      expect(serializedWire).not.toContain(protectedContent);
      expect(serializedWire).toContain("D468 author");
      expect(serializedWire).toContain(`New message in D468 important ${suffix}`);
    } finally {
      if (viewerId) {
        await withTrustContext({ userId: viewerId }, async (tx) => {
          await tx.delete(pushNotificationDeliveries)
            .where(eq(pushNotificationDeliveries.userId, viewerId));
          await tx.delete(pushInstallationBindings)
            .where(eq(pushInstallationBindings.userId, viewerId));
        }, db);
      }
      if (sessionId) {
        await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
        await db.delete(sessions).where(eq(sessions.id, sessionId));
      }
      await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await db.delete(rooms).where(eq(rooms.id, roomId));
      if (namespaceId) await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
      if (authorActorId) await db.delete(actors).where(eq(actors.id, authorActorId));
      if (viewerActorId) await db.delete(actors).where(eq(actors.id, viewerActorId));
      if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
      if (authorId) await db.delete(users).where(eq(users.id, authorId));
      if (viewerId) await db.delete(users).where(eq(users.id, viewerId));
    }
  });
});
