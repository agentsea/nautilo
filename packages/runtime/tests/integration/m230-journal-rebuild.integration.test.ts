/**
 * ISSUE-M230 — edit-triggered Room-journal rebuild against live Postgres.
 *
 * Run against an already-migrated named instance:
 *   NAUTILO_INSTANCE_ID=test-cruft bun test --timeout 60000 \
 *     packages/runtime/tests/integration/m230-journal-rebuild.integration.test.ts
 *
 * No model or external service is used. The repository is driven directly
 * with synthetic extraction operations to prove the generation, lease, and cursor behavior.
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
  inArray,
  llmUsageEvents,
  readRoomJournalServiceRecoveryPage,
  queryStenographerAdminStatus,
  rebindRoomJournalFailedBatchServiceModel,
  namespaces,
  reflectionRecordAuthorityBlocks,
  reflectionRecordAuthorityDependencies,
  reflectionRecordSemanticWork,
  reflectionRecordSuccessors,
  reflectionRecords,
  roomEvents,
  roomJournalBatches,
  roomJournalRecordRebuildRetirements,
  roomJournalState,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  PostgresSemanticWorkStore,
  createHmacRecordSemanticCommitmentPort,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";
import { editHumanRoomMessage } from "@nautilo/trust";
import { createProductionReflectionMemoryRuntime } from "../../src/reflection/production-reflection-memory";
import {
  claimJournalRebuildExtraction,
  claimNextExtraction,
  failExtraction,
  prepareNextJournalRebuild,
} from "../../src/stenographer/repository";
import {
  createNativeStenographerExtractionPublisher,
  createRecordProductPostgresConnection,
  type NativeStenographerPublicationRuntime,
} from "../../src/stenographer/native-record-publication";

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
const SECOND_MESSAGE_TIME = new Date("2000-01-01T08:01:30.000Z");
const FIRST_EXTRACTION_TIME = new Date("2000-01-01T08:03:00.000Z");
const SECOND_EXTRACTION_TIME = new Date("2000-01-01T08:04:00.000Z");
const DEPENDENT_EDIT_TIME = new Date("2000-01-01T08:05:00.000Z");
const SECOND_DEPENDENT_EDIT_TIME = new Date("2000-01-01T08:06:00.000Z");
const QUARANTINE_TIME = new Date("2029-01-01T00:00:00.000Z");
const TARGET_RECOVERY_TIME = new Date("2030-01-03T00:00:00.000Z");
const DEPENDENCY_RECOVERY_TIME = new Date("2030-01-04T00:00:00.000Z");

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
  await db?.end();
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
  if (!liveFixtures.has(fixture)) return;
  await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, fixture.sessionId));
  await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
  await db.delete(roomMembers).where(eq(roomMembers.roomId, fixture.roomId));
  await db.delete(rooms).where(eq(rooms.id, fixture.roomId));
  await db.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
  await db.delete(actors).where(eq(actors.id, fixture.agentActorId));
  await db.delete(agents).where(eq(agents.id, fixture.agentId));
  await db.delete(actors).where(eq(actors.id, fixture.userActorId));
  await db.delete(users).where(eq(users.id, fixture.userId));
  liveFixtures.delete(fixture);
}

async function readState(roomId: string) {
  const [state] = await db
    .select()
    .from(roomJournalState)
    .where(eq(roomJournalState.roomId, roomId));
  return state;
}

async function initializeFixtureJournal(fixture: Fixture): Promise<void> {
  await db.insert(roomJournalState).values({
    roomId: fixture.roomId,
    lastProcessedMessageId: 0,
    extractorVersion: "m219-v1",
    historicalBackfillStatus: "not_needed",
    createdAt: BASE,
    updatedAt: BASE,
  });
}

describe("M230 Room-journal rebuild (live Postgres)", () => {
  test.each([
    ["openai:gpt-5.6-sol", "openai", "venice:test-model", "provider_refused", false],
    ["venice:test-model", "venice", "openai:gpt-5.6-sol", "provider_refused", false],
    ["openai:gpt-5.6-sol", "surplus", "venice:test-model", "no_sellers_for_model", false],
    ["openai:gpt-5.6-sol", "surplus", "venice:test-model", "no_sellers_for_model", true],
  ] as const)("rediscovers and fences a refused %s Journal attempt via %s", async (
    oldModel, route, configuredModel, refusal, earlierUnknown,
  ) => {
    const fixture = await makeFixture("automatic-provider-recovery");
    const binding = {
      version: 1, kind: "service", role: "memorySummarization",
      modelId: oldModel, inputCommitment: `hmac-sha256:${"B".repeat(42)}A`,
    } as const;
    try {
      // A prepared rebuild must resume the exact failed batch via normal
      // scheduling. Unprepared rebuilds still belong to transcript invalidation.
      await editHumanRoomMessage({
        roomId: fixture.roomId, messageId: fixture.messageId,
        callerUserId: fixture.userId, callerActorId: fixture.userActorId,
        content: "journal text after edit", expectedRevision: 0, now: FIRST_EDIT_TIME,
      });
      expect(await prepareNextJournalRebuild({ db, now: REBUILD_TIME })).toBe(fixture.roomId);
      const claim = await claimJournalRebuildExtraction(fixture.roomId, { db, now: REBUILD_TIME });
      if (!claim) throw new Error("expected a prepared rebuild claim");
      await db.update(roomJournalBatches).set({ acceptedModelBinding: binding })
        .where(eq(roomJournalBatches.id, claim.batchId));
      const usage = {
        roomId: fixture.roomId, callType: "room_stenographer",
        model: oldModel, provider: route, providerRoute: route, fundingKind: "service",
        endpoint: "/v1/chat/completions",
        metadata: { operationId: claim.batchId },
      } as const;
      const failedAt = new Date(REBUILD_TIME.getTime() + 1_000);
      if (earlierUnknown) {
        await db.insert(llmUsageEvents).values({
          ...usage, occurredAt: new Date(REBUILD_TIME.getTime() - 1_000),
          attemptOutcome: "unknown", costState: "unknown", failureCode: "outcome_unknown",
        });
      }
      await db.insert(llmUsageEvents).values({
        ...usage, occurredAt: failedAt, attemptOutcome: "failed", failureCode: refusal,
        costState: route === "surplus" ? "unknown" : "estimated",
      });
      await failExtraction({ claim, errorCode: "provider", modelId: oldModel, db, now: failedAt });
      const page = await readRoomJournalServiceRecoveryPage(db, { modelId: configuredModel, limit: 20 });
      const candidate = page.find(row => row.batchId === claim.batchId);
      if (!candidate) throw new Error("expected the failed rebuild batch on the recovery page");
      expect(await readRoomJournalServiceRecoveryPage(db, { modelId: oldModel, limit: 20 }))
        .not.toContainEqual(candidate);

      const now = new Date(failedAt.getTime() + 1_000);
      const result = await rebindRoomJournalFailedBatchServiceModel(db, { ...candidate, modelId: configuredModel, now });
      if (earlierUnknown) {
        expect(result).toMatchObject({ status: "blocked", reason: "attempt_outcome_not_refused" });
        await db.update(roomJournalState).set({ lastExtractionErrorCode: "provider_outcome_unknown" })
          .where(eq(roomJournalState.roomId, fixture.roomId));
        const health = await queryStenographerAdminStatus({ now, since: now, until: now, includeRecovery: true }, db);
        expect(health.recentFailures).toEqual([]);
        expect(health.health).toBe("degraded");
        expect(health.unresolvedProviderOutcomes).toBe(1);
        return;
      }
      expect(result).toEqual({ status: "queued", rebuildGeneration: candidate.expectedRebuildGeneration });
      expect(await rebindRoomJournalFailedBatchServiceModel(db, { ...candidate, modelId: configuredModel, now }))
        .toMatchObject({ status: "stale" });
      expect(await prepareNextJournalRebuild({ db, now })).toBe(fixture.roomId);
      const resumed = await claimJournalRebuildExtraction(fixture.roomId, { db, now });
      expect(resumed).toMatchObject({ batchId: claim.batchId, rebuildGeneration: claim.rebuildGeneration });
      expect(await db.select({ binding: roomJournalBatches.acceptedModelBinding })
        .from(roomJournalBatches).where(eq(roomJournalBatches.id, claim.batchId)))
        .toEqual([{ binding: { ...binding, modelId: configuredModel } }]);
    } finally {
      await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, fixture.roomId));
      await cleanupFixture(fixture);
    }
  });

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

  test("sunsets pending native Records across rebuild generations and settles stale Reflection work", async () => {
    const fixture = await makeFixture("quarantined-sunset");
    const recordRefs: string[] = [];
    const cleanupRecordRefs: string[] = [];
    try {
      await initializeFixtureJournal(fixture);
      const firstClaim = await claimNextExtraction({ db, now: FIRST_EXTRACTION_TIME });
      expect(firstClaim?.roomId).toBe(fixture.roomId);
      expect(await publisher.publishExtraction({
        claim: firstClaim!,
        operations: [{
          op: "append",
          kind: "fact",
          statement: "Journal evidence before the edit.",
          sourceMessageIds: [fixture.messageId],
        }],
        modelId: null,
        now: FIRST_EXTRACTION_TIME,
      })).toEqual({ published: true, eventsWritten: 1 });

      const [secondMessage] = await db.insert(sessionMessages).values({
        sessionId: fixture.sessionId,
        role: "assistant",
        content: "Dependent journal evidence before the edit",
        fingerprint: `fp:v1:assistant:${randomUUID()}`,
        createdAt: SECOND_MESSAGE_TIME,
      }).returning({ id: sessionMessages.id });
      if (!secondMessage) throw new Error("failed to create dependent message");

      const [firstEvent] = await db.select({ recordId: roomEvents.recordId })
        .from(roomEvents)
        .where(eq(roomEvents.roomId, fixture.roomId));
      if (firstEvent?.recordId == null) throw new Error("missing first native Journal Record");
      recordRefs.push(firstEvent.recordId);
      cleanupRecordRefs.push(firstEvent.recordId);

      const secondClaim = await claimNextExtraction({ db, now: SECOND_EXTRACTION_TIME });
      expect(secondClaim?.roomId).toBe(fixture.roomId);
      expect(await publisher.publishExtraction({
        claim: secondClaim!,
        operations: [{
          op: "append",
          kind: "fact",
          statement: "Journal evidence depending on the earlier Record.",
          sourceMessageIds: [secondMessage.id],
        }],
        modelExposureDependencies: [{
          kind: "record",
          recordRef: firstEvent.recordId,
          observedProcessingGeneration: 1,
          terminalAuthorityLeafHandles: [fixture.namespaceId],
        }],
        modelId: null,
        now: SECOND_EXTRACTION_TIME,
      })).toEqual({ published: true, eventsWritten: 1 });

      const events = await db.select({
        recordId: roomEvents.recordId,
        sequence: roomEvents.sequence,
      }).from(roomEvents)
        .where(eq(roomEvents.roomId, fixture.roomId))
        .orderBy(roomEvents.sequence);
      expect(events).toHaveLength(2);
      const targetRecordRef = events[1]?.recordId;
      if (targetRecordRef == null) throw new Error("missing dependent native Journal Record");
      recordRefs.push(targetRecordRef);
      cleanupRecordRefs.push(targetRecordRef);
      expect(await db.select()
        .from(reflectionRecordAuthorityDependencies)
        .where(and(
          eq(reflectionRecordAuthorityDependencies.recordId, targetRecordRef),
          eq(reflectionRecordAuthorityDependencies.dependencyRecordId, firstEvent.recordId),
        ))).toHaveLength(1);

      const handle = await verifyRecordProductPostgresHandle(
        createRecordProductPostgresConnection(getSharedDirectDb()),
      );
      const commitments = createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(61));
      const beforeDeadline = new PostgresSemanticWorkStore({
        handle,
        commitments,
        clock: () => QUARANTINE_TIME,
      });
      const quarantine = (recordRef: string) => db.update(reflectionRecordSemanticWork).set({
        state: "quarantined",
        attemptCount: 8,
        quarantineRound: 1,
        recoveryPolicyVersion: 2,
        nextAttemptAt: null,
        recoverAfter: TARGET_RECOVERY_TIME,
        failureCode: "authority_unavailable",
        updatedAt: QUARANTINE_TIME,
      }).where(eq(reflectionRecordSemanticWork.recordId, recordRef));
      await quarantine(firstEvent.recordId);
      // Advance the dependent Record through the production checkpoint path.
      for (const stage of ["authority_projection", "search_projection"] as const) {
        const work = await beforeDeadline.claimNext();
        expect(work).toMatchObject({ status: "claimed", claim: { recordRef: targetRecordRef, stage } });
        if (work.status !== "claimed") throw new Error("expected dependent Record claim");
        expect(await beforeDeadline.checkpoint({
          claim: work.claim, completedStage: stage,
        })).toMatchObject({ status: "accepted" });
      }
      await quarantine(targetRecordRef);

      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "Journal evidence after the edit",
        expectedRevision: 0,
        now: DEPENDENT_EDIT_TIME,
      });
      const staleRecords = await db.select({
        recordId: reflectionRecords.recordId,
        lifecycle: reflectionRecords.lifecycle,
      }).from(reflectionRecords)
        .where(inArray(reflectionRecords.recordId, recordRefs))
        .orderBy(reflectionRecords.recordId);
      expect(staleRecords).toHaveLength(recordRefs.length);
      for (const recordRef of recordRefs) {
        expect(staleRecords.find(record => record.recordId === recordRef)?.lifecycle)
          .toBe("stale");
      }
      expect(await db.select()
        .from(reflectionRecordSuccessors)
        .where(inArray(reflectionRecordSuccessors.predecessorRecordId, recordRefs)))
        .toHaveLength(0);
      expect(await db.select({ state: roomJournalRecordRebuildRetirements.state })
        .from(roomJournalRecordRebuildRetirements)
        .where(eq(roomJournalRecordRebuildRetirements.roomId, fixture.roomId)))
        .toEqual([{ state: "pending" }, { state: "pending" }]);

      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "Journal evidence after the second edit",
        expectedRevision: 1,
        now: SECOND_DEPENDENT_EDIT_TIME,
      });
      expect(await readState(fixture.roomId)).toMatchObject({
        rebuildGeneration: 2,
        rebuildRequestedAt: SECOND_DEPENDENT_EDIT_TIME,
      });
      expect(await db.select({
        rebuildGeneration: roomJournalRecordRebuildRetirements.rebuildGeneration,
        recordId: roomJournalRecordRebuildRetirements.recordId,
        state: roomJournalRecordRebuildRetirements.state,
      }).from(roomJournalRecordRebuildRetirements)
        .where(eq(roomJournalRecordRebuildRetirements.roomId, fixture.roomId))
        .orderBy(
          roomJournalRecordRebuildRetirements.rebuildGeneration,
          roomJournalRecordRebuildRetirements.recordId,
        ))
        .toEqual([1, 2].flatMap(rebuildGeneration => [...recordRefs].sort().map(recordId => ({
          rebuildGeneration,
          recordId,
          state: "pending",
        }))));

      expect(await prepareNextJournalRebuild({ db, now: REBUILD_TIME }))
        .toBe(fixture.roomId);
      const rebuildClaim = await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: REBUILD_TIME,
      });
      expect(rebuildClaim).not.toBeNull();
      expect(await publisher.publishExtraction({
        claim: rebuildClaim!,
        operations: [{
          op: "append",
          kind: "fact",
          statement: "Current Journal evidence after the rebuild.",
          sourceMessageIds: [fixture.messageId],
        }],
        modelId: null,
        now: REBUILD_TIME,
      })).toEqual({ published: true, eventsWritten: 1 });
      expect(await readState(fixture.roomId)).toMatchObject({
        rebuildGeneration: 2,
        rebuildRequestedAt: null,
        rebuildTargetMessageId: null,
      });
      const [survivor] = await db.select({
        recordId: roomEvents.recordId,
      }).from(roomEvents)
        .where(and(
          eq(roomEvents.roomId, fixture.roomId),
          eq(roomEvents.status, "active"),
        ));
      if (survivor?.recordId == null) throw new Error("missing current rebuild survivor");
      cleanupRecordRefs.push(survivor.recordId);
      expect(recordRefs).not.toContain(survivor.recordId);
      expect(await db.select({ lifecycle: reflectionRecords.lifecycle })
        .from(reflectionRecords)
        .where(eq(reflectionRecords.recordId, survivor.recordId)))
        .toEqual([{ lifecycle: "current" }]);
      await db.update(reflectionRecordSemanticWork).set({
        nextAttemptAt: DEPENDENCY_RECOVERY_TIME,
      }).where(eq(reflectionRecordSemanticWork.recordId, survivor.recordId));
      const sunsetRecords = await db.select({
        recordId: reflectionRecords.recordId,
        lifecycle: reflectionRecords.lifecycle,
      }).from(reflectionRecords)
        .where(inArray(reflectionRecords.recordId, recordRefs))
        .orderBy(reflectionRecords.recordId);
      expect(sunsetRecords).toHaveLength(recordRefs.length);
      for (const recordRef of recordRefs) {
        expect(sunsetRecords.find(record => record.recordId === recordRef)?.lifecycle)
          .toBe("sunset");
      }
      expect(await db.select({
        rebuildGeneration: roomJournalRecordRebuildRetirements.rebuildGeneration,
        state: roomJournalRecordRebuildRetirements.state,
      })
        .from(roomJournalRecordRebuildRetirements)
        .where(eq(roomJournalRecordRebuildRetirements.roomId, fixture.roomId))
        .orderBy(roomJournalRecordRebuildRetirements.rebuildGeneration))
        .toEqual([1, 1, 2, 2].map(rebuildGeneration => ({
          rebuildGeneration,
          state: "sunset",
        })));

      expect(await beforeDeadline.claimNext()).toEqual({ status: "empty" });
      const semanticWork = new PostgresSemanticWorkStore({
        handle,
        commitments,
        clock: () => TARGET_RECOVERY_TIME,
      });
      const recoveredStages = new Map<string, string>();
      for (let index = 0; index < recordRefs.length; index += 1) {
        const recovered = await semanticWork.claimNext();
        expect(recovered).toMatchObject({
          status: "claimed",
          claim: {
            recoveredFromQuarantine: true,
          },
        });
        if (recovered.status !== "claimed") throw new Error("expected scheduled recovery claim");
        recoveredStages.set(recovered.claim.recordRef, recovered.claim.stage);
        expect(await semanticWork.settleCurrentState({ claim: recovered.claim }))
          .toMatchObject({
            status: "settled",
            reason: "record_lifecycle_obsolete",
          });
      }
      expect(recoveredStages.get(targetRecordRef)).toBe("organization");
      expect(recoveredStages.get(firstEvent.recordId)).toBe("authority_projection");
      expect(await db.select({
        recordId: reflectionRecordSemanticWork.recordId,
        state: reflectionRecordSemanticWork.state,
        completionOutcome: reflectionRecordSemanticWork.completionOutcome,
        recoverAfter: reflectionRecordSemanticWork.recoverAfter,
      }).from(reflectionRecordSemanticWork)
        .where(inArray(reflectionRecordSemanticWork.recordId, recordRefs))
        .orderBy(reflectionRecordSemanticWork.recordId))
        .toEqual([...recordRefs].sort().map(recordId => ({
          recordId,
          state: "complete",
          completionOutcome: "record_lifecycle_obsolete",
          recoverAfter: null,
        })));
      expect(await db.select({
        lifecycle: reflectionRecords.lifecycle,
        semanticWorkState: reflectionRecordSemanticWork.state,
      })
        .from(reflectionRecords)
        .innerJoin(
          reflectionRecordSemanticWork,
          eq(reflectionRecordSemanticWork.recordId, reflectionRecords.recordId),
        )
        .where(eq(reflectionRecords.recordId, survivor.recordId)))
        .toEqual([{ lifecycle: "current", semanticWorkState: "due" }]);
    } finally {
      if (cleanupRecordRefs.length > 0) {
        await db.update(reflectionRecords)
          .set({ disposition: "purged" })
          .where(inArray(reflectionRecords.recordId, cleanupRecordRefs));
      }
      await cleanupFixture(fixture);
    }
  });

  test("reads a retired native Journal predecessor only through its canonical edge", async () => {
    const fixture = await makeFixture("retired-predecessor");
    const recordRefs: string[] = [];
    try {
      await initializeFixtureJournal(fixture);
      const firstClaim = await claimNextExtraction({ db, now: FIRST_EXTRACTION_TIME });
      expect(firstClaim?.roomId).toBe(fixture.roomId);
      expect(await publisher.publishExtraction({
        claim: firstClaim!,
        operations: [{
          op: "append",
          kind: "fact",
          statement: "Original Journal evidence.",
          sourceMessageIds: [fixture.messageId],
        }],
        modelId: null,
        now: FIRST_EXTRACTION_TIME,
      })).toEqual({ published: true, eventsWritten: 1 });

      const [originalEvent] = await db.select({
        recordId: roomEvents.recordId,
        sequence: roomEvents.sequence,
      }).from(roomEvents)
        .where(eq(roomEvents.roomId, fixture.roomId));
      if (originalEvent?.recordId == null) throw new Error("missing original native Journal Record");
      recordRefs.push(originalEvent.recordId);
      const [originalRecord] = await db.select({
        processingGeneration: reflectionRecords.processingGeneration,
      }).from(reflectionRecords)
        .where(eq(reflectionRecords.recordId, originalEvent.recordId));
      if (originalRecord === undefined) throw new Error("missing original Record generation");
      const oldDependency = {
        kind: "record" as const,
        recordRef: originalEvent.recordId,
        observedProcessingGeneration: originalRecord.processingGeneration,
        terminalAuthorityLeafHandles: [fixture.namespaceId],
      };

      const [secondMessage] = await db.insert(sessionMessages).values({
        sessionId: fixture.sessionId,
        role: "assistant",
        content: "Corrected Journal evidence",
        fingerprint: `fp:v1:assistant:${randomUUID()}`,
        createdAt: SECOND_MESSAGE_TIME,
      }).returning({ id: sessionMessages.id });
      if (!secondMessage) throw new Error("failed to create replacement message");
      const secondClaim = await claimNextExtraction({ db, now: SECOND_EXTRACTION_TIME });
      expect(secondClaim?.roomId).toBe(fixture.roomId);
      expect(await publisher.publishExtraction({
        claim: secondClaim!,
        operations: [{
          op: "supersede",
          eventSequence: originalEvent.sequence,
          kind: "fact",
          statement: "Corrected Journal evidence.",
          sourceMessageIds: [secondMessage.id],
        }],
        modelId: null,
        now: SECOND_EXTRACTION_TIME,
      })).toEqual({ published: true, eventsWritten: 1 });
      const successorEvents = await db.select({ recordId: roomEvents.recordId })
        .from(roomEvents)
        .where(eq(roomEvents.roomId, fixture.roomId));
      recordRefs.push(...successorEvents.flatMap(event => event.recordId === null
        || event.recordId === originalEvent.recordId ? [] : [event.recordId]));

      const runtime = await createProductionReflectionMemoryRuntime({
        db,
        selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
        commitmentKey: new Uint8Array(32).fill(67),
        maintenanceGate: { isAcceptingWork: async () => false },
        resolveModelId: () => "integration:no-model-call",
        recordEmbedding: {
          embed: async () => ({
            status: "available",
            embedding: {
              provenance: {
                provider: "openai",
                canonicalModel: "text-embedding-3-small",
                dimensions: 1_536,
                contractVersion: 1,
              },
              vector: Array.from({ length: 1_536 }, () => 0),
            },
          }),
        },
      });
      expect(await runtime.readMemoryEvidenceRecord(oldDependency)).toBeNull();
      expect(await runtime.readRetiredJournalPredecessor(oldDependency, fixture.roomId))
        .toMatchObject({
          recordRef: originalEvent.recordId,
          lifecycle: "superseded",
          processingGeneration: originalRecord.processingGeneration + 1,
        });
      expect(await runtime.readRetiredJournalPredecessor(oldDependency, randomUUID()))
        .toBeNull();
      expect(await runtime.readRetiredJournalPredecessor({
        ...oldDependency,
        observedProcessingGeneration: oldDependency.observedProcessingGeneration + 1,
      }, fixture.roomId)).toBeNull();

      await db.insert(reflectionRecordAuthorityBlocks).values({
        blockId: `integration-journal-block:${fixture.roomId}`,
        recordId: originalEvent.recordId,
        disposition: "blocked",
      });
      expect(await runtime.readRetiredJournalPredecessor(oldDependency, fixture.roomId))
        .toBeNull();
    } finally {
      // Authority blocks are immutable. Retire the fixture Records so later
      // workers cannot claim them.
      if (recordRefs.length > 0) {
        await db.update(reflectionRecords)
          .set({ disposition: "purged" })
          .where(inArray(reflectionRecords.recordId, recordRefs));
      }
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

  test("a rebuild preserves invalid-output replay proof across restored input authority", async () => {
    const fixture = await makeFixture("authority-retry");
    const invalidOutputTime = new Date("2000-01-01T09:00:30.000Z");
    const invalidOutputRetryTime = new Date("2000-01-01T09:00:45.000Z");
    const authorityFailureTime = new Date("2000-01-01T09:01:00.000Z");
    const beforeRetryTime = new Date("2000-01-01T09:01:29.999Z");
    const retryTime = new Date("2000-01-01T09:01:30.000Z");
    const recentFailures = async (now: Date) =>
      (await queryStenographerAdminStatus({ now, since: REBUILD_TIME, until: now }, db)).recentFailures;
    try {
      await editHumanRoomMessage({
        roomId: fixture.roomId,
        messageId: fixture.messageId,
        callerUserId: fixture.userId,
        callerActorId: fixture.userActorId,
        content: "edited content waits for restored authority",
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

      await db.insert(llmUsageEvents).values({
        roomId: fixture.roomId, callType: "room_stenographer", model: "openai:gpt-5.6-sol",
        provider: "openai", fundingKind: "service", providerRoute: "openai",
        providerRequestId: randomUUID(), endpoint: "/v1/chat/completions",
        attemptOutcome: "succeeded", costState: "estimated", estimatedCostUsd: "0.01",
        metadata: { operationId: claim!.batchId },
      });
      await failExtraction({
        claim: claim!,
        errorCode: "invalid_output",
        modelId: "openai:gpt-5.6-sol",
        db,
        now: invalidOutputTime,
      });
      expect((await recentFailures(invalidOutputTime)).map((failure) => failure.errorCode)).toEqual(["invalid_output"]);
      expect(
        await prepareNextJournalRebuild({ db, now: invalidOutputRetryTime }),
      ).toBe(fixture.roomId);
      const authorityClaim = await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: invalidOutputRetryTime,
      });
      expect(authorityClaim).not.toBeNull();
      expect(authorityClaim?.batchId).toBe(claim?.batchId);
      expect(authorityClaim?.attemptCount).toBe(2);
      expect(authorityClaim?.previousModelResultKnownNonusable).toBeTrue();

      await db.update(users)
        .set({ disabledAt: authorityFailureTime })
        .where(eq(users.id, fixture.userId));
      await failExtraction({
        claim: authorityClaim!,
        errorCode: "input_authority_unavailable",
        modelId: null,
        db,
        now: authorityFailureTime,
      });
      const [deferredBatch] = await db.select({
        errorCode: roomJournalBatches.errorCode,
        lastErrorAt: roomJournalBatches.lastErrorAt,
        lastErrorAttempt: roomJournalBatches.lastErrorAttempt,
        lastErrorModelId: roomJournalBatches.lastErrorModelId,
      }).from(roomJournalBatches)
        .where(eq(roomJournalBatches.id, claim!.batchId));
      expect(deferredBatch).toEqual({
        errorCode: "invalid_output",
        lastErrorAt: invalidOutputTime,
        lastErrorAttempt: 1,
        lastErrorModelId: "openai:gpt-5.6-sol",
      });
      expect(await readState(fixture.roomId)).toMatchObject({
        rebuildGeneration: 1,
        rebuildRequestedAt: FIRST_EDIT_TIME,
        rebuildTargetMessageId: fixture.messageId,
        leaseToken: null,
        leaseExpiresAt: null,
        extractionFailureCount: 2,
        extractionRetryAfter: retryTime,
        lastExtractionErrorCode: "input_authority_unavailable",
      });
      const deferredFailures = await recentFailures(authorityFailureTime);
      expect(deferredFailures.map((failure) => failure.errorCode)).toEqual(["input_authority_unavailable", "invalid_output"]);
      expect(deferredFailures[0]).toMatchObject({ occurredAt: authorityFailureTime.toISOString(), attemptCount: 2 });

      expect(
        await prepareNextJournalRebuild({ db, now: beforeRetryTime }),
      ).toBe(fixture.roomId);
      expect(await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: beforeRetryTime,
      })).toBeNull();

      await db.update(users)
        .set({ disabledAt: null })
        .where(eq(users.id, fixture.userId));
      expect(
        await prepareNextJournalRebuild({ db, now: retryTime }),
      ).toBe(fixture.roomId);
      const retry = await claimJournalRebuildExtraction(fixture.roomId, {
        db,
        now: retryTime,
      });
      expect(retry).not.toBeNull();
      expect(retry?.batchId).toBe(claim?.batchId);
      expect(retry?.attemptCount).toBe(3);
      expect(retry?.previousModelResultKnownNonusable).toBeTrue();
      expect(retry?.plan.fromMessageIdExclusive).toBe(0);
      expect(retry?.plan.throughMessageIdInclusive).toBe(fixture.messageId);
      expect(retry?.sourceRows.map((row) => row.text)).toEqual([
        "edited content waits for restored authority",
      ]);

      expect(await publisher.publishExtraction({
        claim: retry!,
        operations: [],
        modelId: null,
        now: new Date("2000-01-01T09:01:31.000Z"),
      })).toEqual({ published: true, eventsWritten: 0 });
      expect(await readState(fixture.roomId)).toMatchObject({
        rebuildRequestedAt: null,
        rebuildTargetMessageId: null,
        extractionFailureCount: 0,
        extractionRetryAfter: null,
      });
      expect((await recentFailures(new Date("2000-01-01T09:01:31.000Z"))).map((failure) => failure.errorCode))
        .toEqual([]);
    } finally {
      await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, fixture.roomId));
      await db.update(users)
        .set({ disabledAt: null })
        .where(eq(users.id, fixture.userId));
      await cleanupFixture(fixture);
    }
  });
});
