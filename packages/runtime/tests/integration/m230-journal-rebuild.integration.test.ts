/**
 * ISSUE-M230 — edit-triggered Room-journal rebuild against live Postgres.
 *
 * Run against an already-migrated named instance:
 *   NAUTILO_INSTANCE_ID=test-cruft bun test --timeout 60000 \
 *     packages/runtime/tests/integration/m230-journal-rebuild.integration.test.ts
 *
 * No model or external service is used. The repository is driven directly
 * with empty extraction operations to prove generation/lease/cursor behavior.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  actors,
  agents,
  createDirectDb,
  getSharedDirectDb,
  eq,
  namespaces,
  roomJournalState,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { editHumanRoomMessage } from "@nautilo/trust";
import {
  claimJournalRebuildExtraction,
  failExtraction,
  prepareNextJournalRebuild,
} from "../../src/stenographer/repository";
import { createNativeStenographerExtractionPublisher, type NativeStenographerPublicationRuntime } from "../../src/stenographer/native-record-publication";

let db: ReturnType<typeof createDirectDb>;
let publisher: NativeStenographerPublicationRuntime;
const liveFixtures = new Set<Fixture>();

interface Fixture {
  userId: string;
  userActorId: string;
  agentId: string;
  agentActorId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
  messageId: number;
}

// Deliberately ancient so the global "oldest dirty Room" selector always
// chooses this isolated fixture before any operator-authored dirty Room.
const BASE = new Date("2000-01-01T08:00:00.000Z");
const MESSAGE_TIME = new Date("2000-01-01T08:01:00.000Z");
const FIRST_EDIT_TIME = new Date("2000-01-01T08:02:00.000Z");
const REBUILD_TIME = new Date("2000-01-01T09:00:00.000Z");

beforeAll(async () => {
  bootstrapTestDbInstance();
  db = createDirectDb(4);
  publisher = await createNativeStenographerExtractionPublisher({
    db: getSharedDirectDb(), selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    commitmentKey: new Uint8Array(32).fill(19),
    semanticCommitmentKey: new Uint8Array(32).fill(23),
  });
});

afterAll(async () => {
  for (const fixture of [...liveFixtures]) {
    await cleanupFixture(fixture);
  }
  await db.end();
});

async function makeFixture(label: string): Promise<Fixture> {
  const unique = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      name: `M230 rebuild ${label}`,
      email: `m230-rebuild-${unique}@integration.test`,
      handle: `m230_rebuild_${unique.replaceAll("-", "").slice(0, 12)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("failed to create user");
  const [userActor] = await db
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: "M230 rebuild human",
      kind: "user",
    })
    .returning({ id: actors.id });
  if (!userActor) throw new Error("failed to create user actor");
  const [agent] = await db
    .insert(agents)
    .values({ handle: `m230-rebuild-${unique}` })
    .returning({ id: agents.id });
  if (!agent) throw new Error("failed to create agent");
  const [agentActor] = await db
    .insert(actors)
    .values({
      ownerId: user.id,
      displayName: "M230 rebuild agent",
      kind: "agent",
      agentId: agent.id,
    })
    .returning({ id: actors.id });
  if (!agentActor) throw new Error("failed to create agent actor");
  const [namespace] = await db
    .insert(namespaces)
    .values({ scope: "private", label: `m230-rebuild-${unique}` })
    .returning({ id: namespaces.id });
  if (!namespace) throw new Error("failed to create namespace");
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId,
    ownerId: user.id,
    type: "private",
    label: `M230 rebuild ${label}`,
    graphThreadId: `room:${roomId}`,
    namespaceId: namespace.id,
    humanActorIds: [userActor.id],
    createdBy: userActor.id,
  });
  await db.insert(roomMembers).values([
    {
      roomId,
      actorId: userActor.id,
      roomRole: "admin",
      joinedAt: BASE,
    },
    {
      roomId,
      actorId: agentActor.id,
      roomRole: "member",
      joinedAt: BASE,
    },
  ]);
  const [session] = await db
    .insert(sessions)
    .values({
      threadId: `m230-rebuild:${roomId}`,
      ownerId: user.id,
      personaId: "owner",
      agentId: agent.id,
      roomId,
      channel: "electron",
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("failed to create session");
  const [message] = await db
    .insert(sessionMessages)
    .values({
      sessionId: session.id,
      role: "user",
      content: "journal text before edit",
      fingerprint: `fp:v1:human:${randomUUID()}`,
      createdAt: MESSAGE_TIME,
    })
    .returning({ id: sessionMessages.id });
  if (!message) throw new Error("failed to create message");
  const fixture: Fixture = {
    userId: user.id,
    userActorId: userActor.id,
    agentId: agent.id,
    agentActorId: agentActor.id,
    namespaceId: namespace.id,
    roomId,
    sessionId: session.id,
    messageId: message.id,
  };
  liveFixtures.add(fixture);
  return fixture;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  if (!liveFixtures.delete(fixture)) return;
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, fixture.sessionId));
  await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, fixture.roomId));
  await db.delete(rooms).where(eq(rooms.id, fixture.roomId));
  await db.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
  await db.delete(actors).where(eq(actors.id, fixture.agentActorId));
  await db.delete(agents).where(eq(agents.id, fixture.agentId));
  await db.delete(actors).where(eq(actors.id, fixture.userActorId));
  await db.delete(users).where(eq(users.id, fixture.userId));
}

async function readState(roomId: string) {
  const [state] = await db
    .select()
    .from(roomJournalState)
    .where(eq(roomJournalState.roomId, roomId));
  return state;
}

describe("M230 Room-journal rebuild (live Postgres)", () => {
  test("prepares a dirty Room through the typed cleanup transaction", async () => {
    const fixture = await makeFixture("typed-cleanup");
    try {
      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "journal text after typed cleanup edit",
        expectedRevision: 0,
        now: FIRST_EDIT_TIME,
      });

      expect(
        await prepareNextJournalRebuild({ db, now: REBUILD_TIME }),
      ).toBe(fixture.roomId);
      expect(await readState(fixture.roomId)).toMatchObject({
        lastProcessedMessageId: 0,
        rebuildGeneration: 1,
        rebuildRequestedAt: FIRST_EDIT_TIME,
        rebuildTargetMessageId: fixture.messageId,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("completes a dirty Room whose private replay range is already empty", async () => {
    const fixture = await makeFixture("typed-complete");
    try {
      await db
        .update(roomMembers)
        .set({ joinedAt: FIRST_EDIT_TIME })
        .where(
          and(
            eq(roomMembers.roomId, fixture.roomId),
            eq(roomMembers.actorId, fixture.agentActorId),
          ),
        );
      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "journal text with no private replay range",
        expectedRevision: 0,
        now: FIRST_EDIT_TIME,
      });

      expect(
        await prepareNextJournalRebuild({ db, now: REBUILD_TIME }),
      ).toBeNull();
      expect(await readState(fixture.roomId)).toMatchObject({
        lastProcessedMessageId: fixture.messageId,
        rebuildGeneration: 1,
        rebuildRequestedAt: null,
        rebuildTargetMessageId: null,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("replays edited transcript content and clears only the matching dirty generation", async () => {
    const fixture = await makeFixture("generation");
    try {
      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "journal text after first edit",
        expectedRevision: 0,
        now: FIRST_EDIT_TIME,
      });

      expect(
        await prepareNextJournalRebuild({ db, now: REBUILD_TIME }),
      ).toBe(fixture.roomId);
      const firstClaim = await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: REBUILD_TIME,
      });
      expect(firstClaim).not.toBeNull();
      expect(firstClaim?.rebuildGeneration).toBe(1);
      expect(firstClaim?.sourceRows.map((row) => row.text)).toEqual([
        "journal text after first edit",
      ]);

      const secondEditTime = new Date("2000-01-01T09:01:00.000Z");
      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "journal text after second edit",
        expectedRevision: 1,
        now: secondEditTime,
      });
      const stalePublish = await publisher.publishExtraction({
        claim: firstClaim!,
        operations: [],
        modelId: null,
        now: new Date("2000-01-01T09:02:00.000Z"),
      });
      expect(stalePublish).toEqual({ published: false, eventsWritten: 0 });
      expect(await readState(fixture.roomId)).toMatchObject({
        rebuildGeneration: 2,
        rebuildRequestedAt: secondEditTime,
        rebuildTargetMessageId: null,
      });

      const secondRebuildTime = new Date("2000-01-01T10:00:00.000Z");
      expect(
        await prepareNextJournalRebuild({
          db,
          now: secondRebuildTime,
        }),
      ).toBe(fixture.roomId);
      const secondClaim = await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: secondRebuildTime,
      });
      expect(secondClaim).not.toBeNull();
      expect(secondClaim?.rebuildGeneration).toBe(2);
      expect(secondClaim?.sourceRows.map((row) => row.text)).toEqual([
        "journal text after second edit",
      ]);
      const published = await publisher.publishExtraction({
        claim: secondClaim!,
        operations: [],
        modelId: null,
        now: new Date("2000-01-01T10:01:00.000Z"),
      });
      expect(published).toEqual({ published: true, eventsWritten: 0 });
      expect(await readState(fixture.roomId)).toMatchObject({
        lastProcessedMessageId: fixture.messageId,
        rebuildGeneration: 2,
        rebuildRequestedAt: null,
        rebuildTargetMessageId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("a failed rebuild remains dirty, releases its lease, and is retryable", async () => {
    const fixture = await makeFixture("retry");
    try {
      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "edited content survives retry",
        expectedRevision: 0,
        now: FIRST_EDIT_TIME,
      });
      expect(
        await prepareNextJournalRebuild({ db, now: REBUILD_TIME }),
      ).toBe(fixture.roomId);
      const claim = await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: REBUILD_TIME,
      });
      expect(claim).not.toBeNull();

      await failExtraction({
        claim: claim!,
        errorCode: "provider",
        modelId: "integration-stub",
        db,
        now: new Date("2000-01-01T09:01:00.000Z"),
      });
      const failed = await readState(fixture.roomId);
      expect(failed).toMatchObject({
        rebuildGeneration: 1,
        rebuildRequestedAt: FIRST_EDIT_TIME,
        rebuildTargetMessageId: fixture.messageId,
        leaseToken: null,
        leaseExpiresAt: null,
        extractionFailureCount: 1,
        lastExtractionErrorCode: "provider",
      });

      const retryTime = new Date("2000-01-01T09:20:00.000Z");
      expect(
        await prepareNextJournalRebuild({ db, now: retryTime }),
      ).toBe(fixture.roomId);
      const retry = await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: retryTime,
      });
      expect(retry).not.toBeNull();
      expect(retry?.attemptCount).toBe(2);
      expect(retry?.sourceRows.map((row) => row.text)).toEqual([
        "edited content survives retry",
      ]);
      const published = await publisher.publishExtraction({
        claim: retry!,
        operations: [],
        modelId: null,
        now: new Date("2000-01-01T09:21:00.000Z"),
      });
      expect(published.published).toBe(true);
      expect(await readState(fixture.roomId)).toMatchObject({
        rebuildRequestedAt: null,
        rebuildTargetMessageId: null,
        extractionFailureCount: 0,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
