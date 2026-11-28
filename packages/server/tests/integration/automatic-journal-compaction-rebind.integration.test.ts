import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  actors, agents, createDirectDb, ensureDatabase, eq, inArray, llmUsageEvents,
  namespaces, reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations, reflectionRecords, roomEvents,
  readRoomJournalCompactionServiceRecoveryPage,
  roomEventRollups, roomJournalBatches, roomJournalModelRecoveries, roomJournalState, roomMembers,
  rooms, sessionMessages, sessions, sql, users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { isCurrentOrdinaryCompactionAcceptedPlan, tryClaimCompactionRoom } from "@nautilo/runtime";
import { createAutomaticMemoryRecovery } from "../../src/lib/memory-recovery-service";

const OLD_MODEL = "openai:compaction-old";
const NEW_MODEL = "venice:compaction-new";
const BASE = new Date("2026-08-10T10:00:00.000Z");
const NOW = new Date("2026-08-10T10:10:00.000Z");
const EXTRACTOR = "automatic-compaction-rebind-v1";
type Db = ReturnType<typeof createDirectDb>;

let db: Db;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(4);
});

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await db?.end();
});

async function refusedCompaction(label: string) {
  const suffix = randomUUID();
  const [user] = await db.insert(users).values({
    name: `Automatic compaction ${label}`,
    email: `automatic-compaction-${suffix}@integration.test`,
  }).returning({ id: users.id });
  const [human] = await db.insert(actors).values({
    ownerId: user!.id, displayName: "Automatic compaction operator", kind: "user",
  }).returning({ id: actors.id });
  const [agent] = await db.insert(agents).values({ handle: `automatic-compaction-${suffix}` })
    .returning({ id: agents.id });
  const [agentActor] = await db.insert(actors).values({
    ownerId: user!.id, displayName: "Automatic compaction Agent", kind: "agent", agentId: agent!.id,
  }).returning({ id: actors.id });
  const [namespace] = await db.insert(namespaces).values({ scope: "private", label: suffix })
    .returning({ id: namespaces.id });
  const roomId = randomUUID();
  await db.insert(rooms).values({
    id: roomId, ownerId: user!.id, type: "private", label,
    graphThreadId: `room:${roomId}`, namespaceId: namespace!.id,
    humanActorIds: [human!.id], createdBy: human!.id,
  });
  await db.insert(roomMembers).values([
    { roomId, actorId: human!.id, roomRole: "admin", joinedAt: BASE },
    { roomId, actorId: agentActor!.id, roomRole: "member", joinedAt: BASE },
  ]);
  const [session] = await db.insert(sessions).values({
    threadId: `automatic-compaction:${suffix}`, ownerId: user!.id,
    personaId: "owner", agentId: agent!.id, roomId, channel: "electron",
  }).returning({ id: sessions.id });
  const [message] = await db.insert(sessionMessages).values({
    sessionId: session!.id, role: "user", content: "Compaction source",
    fingerprint: `fp:v1:human:${suffix}`, createdAt: BASE,
  }).returning({ id: sessionMessages.id });
  await db.insert(roomJournalState).values({
    roomId, extractorVersion: EXTRACTOR, historicalBackfillStatus: "not_needed",
    compactionDueAt: BASE, createdAt: BASE, updatedAt: BASE,
  });
  const [batch] = await db.insert(roomJournalBatches).values({
    roomId, fromMessageIdExclusive: 0, throughMessageIdInclusive: message!.id,
    extractorVersion: EXTRACTOR, observationPublicationVersion: 2,
    status: "completed", attemptCount: 1, operationCount: 0,
    completedAt: BASE, createdAt: BASE,
  }).returning({ id: roomJournalBatches.id });
  const recordIds = Array.from({ length: 80 }, () => randomUUID());
  const encoder = new TextEncoder();
  await db.transaction(async tx => {
    await tx.insert(reflectionRecords).values(recordIds.map(recordId => ({
      recordId, lifecycle: "current" as const, structuralHeight: 0,
      producerPolicyVersion: EXTRACTOR, processingGeneration: 1, payloadVersion: 1,
      disposition: "available" as const, createdAt: BASE, updatedAt: BASE,
    })));
    await tx.insert(reflectionRecordPayloadRepresentations).values(recordIds.map((recordId, index) => ({
      recordId, representation: "ordinary" as const, representationGeneration: 1,
      payloadVersion: 1, createdAt: BASE,
      plaintextPayloadBytes: encoder.encode(JSON.stringify({
        statement: `Compaction fact ${index + 1} ${"x".repeat(520)}`,
      })),
    })));
    await tx.insert(reflectionRecordPayloadRepresentationHeads).values(recordIds.map(recordId => ({
      recordId, representation: "ordinary" as const,
      currentRepresentationGeneration: 1, updatedAt: BASE,
    })));
    await tx.execute(sql`SELECT set_config('nautilo.stenographer_writer_version', '2', true)`);
    await tx.insert(roomEvents).values(recordIds.map((recordId, index) => ({
      id: recordId, roomId, sequence: index + 1, kind: "fact" as const,
      statement: null, status: "active" as const, sourceMessageIds: [message!.id],
      sourceBatchId: batch!.id, batchLocalOrdinal: index, extractorVersion: EXTRACTOR,
      projectionKind: "native" as const, recordId, nativeAttachedAt: BASE, createdAt: BASE,
    })));
  });
  const claim = await tryClaimCompactionRoom(db, roomId, BASE);
  if (!claim) throw new Error("expected initial compaction claim");
  const binding = {
    version: 1 as const, kind: "service" as const, role: "memorySummarization" as const,
    modelId: OLD_MODEL, inputCommitment: `hmac-sha256:${"A".repeat(43)}`,
  };
  await db.update(roomJournalState).set({
    compactionAcceptedModelBinding: binding,
    compactionAcceptedPlan: claim.acceptedPlan,
    compactionLeaseToken: null,
    compactionLeaseExpiresAt: null,
    compactionFailureCount: 1,
    compactionRetryAfter: new Date(NOW.getTime() + 60_000),
    lastCompactionErrorCode: "provider",
    lastCompactionErrorAt: new Date(NOW.getTime() - 1_000),
    lastCompactionErrorAttempt: 1,
    lastCompactionErrorModelId: OLD_MODEL,
    updatedAt: NOW,
  }).where(eq(roomJournalState.roomId, roomId));
  await db.insert(llmUsageEvents).values({
    roomId, occurredAt: new Date(NOW.getTime() - 1_000), callType: "room_event_compaction",
    model: OLD_MODEL, provider: "openai", providerRoute: "direct", fundingKind: "service",
    endpoint: "/v1/responses", attemptOutcome: "failed", failureCode: "no_sellers_for_model",
    costState: "unknown", metadata: { operationId: claim.modelOperationId },
  });
  cleanups.push(async () => {
    await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, roomId));
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, session!.id));
    await db.delete(sessions).where(eq(sessions.id, session!.id));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
    await db.delete(rooms).where(eq(rooms.id, roomId));
    await db.update(reflectionRecords).set({ disposition: "purged" }).where(inArray(reflectionRecords.recordId, recordIds));
    await db.delete(reflectionRecordPayloadRepresentationHeads).where(inArray(reflectionRecordPayloadRepresentationHeads.recordId, recordIds));
    await db.delete(reflectionRecordPayloadRepresentations).where(inArray(reflectionRecordPayloadRepresentations.recordId, recordIds));
    await db.delete(namespaces).where(eq(namespaces.id, namespace!.id));
    await db.delete(actors).where(eq(actors.id, agentActor!.id));
    await db.delete(agents).where(eq(agents.id, agent!.id));
    await db.delete(actors).where(eq(actors.id, human!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  });
  return { roomId, userId: user!.id, recordIds, claim, binding };
}

function recovery() {
  return createAutomaticMemoryRecovery({
    db: () => db,
    resolveJournalModel: () => NEW_MODEL,
    resolveReflectionModel: () => NEW_MODEL,
  });
}

async function readState(roomId: string) {
  const [state] = await db.select({
    binding: roomJournalState.compactionAcceptedModelBinding,
    plan: roomJournalState.compactionAcceptedPlan,
    retryAfter: roomJournalState.compactionRetryAfter,
    errorCode: roomJournalState.lastCompactionErrorCode,
    errorAt: roomJournalState.lastCompactionErrorAt,
    errorAttempt: roomJournalState.lastCompactionErrorAttempt,
    errorModelId: roomJournalState.lastCompactionErrorModelId,
  }).from(roomJournalState).where(eq(roomJournalState.roomId, roomId));
  return state!;
}

test("automatic Journal recovery rebinds only an exact current refused-service compaction plan", async () => {
  const f = await refusedCompaction("eligible");
  const original = await readState(f.roomId);
  const input = { now: NOW, limit: 20, signal: new AbortController().signal };

  await db.update(llmUsageEvents).set({ occurredAt: NOW }).where(eq(llmUsageEvents.roomId, f.roomId));
  await recovery().recoverJournal(input);
  expect((await readState(f.roomId)).binding).toEqual(f.binding);
  await db.update(llmUsageEvents).set({ occurredAt: original.errorAt! }).where(eq(llmUsageEvents.roomId, f.roomId));

  await db.update(roomJournalState).set({
    compactionLeaseToken: randomUUID(),
    compactionLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
  }).where(eq(roomJournalState.roomId, f.roomId));
  await recovery().recoverJournal(input);
  expect((await readState(f.roomId)).binding).toEqual(f.binding);

  await db.update(roomJournalState).set({ compactionLeaseToken: null, compactionLeaseExpiresAt: null })
    .where(eq(roomJournalState.roomId, f.roomId));
  await db.insert(roomJournalModelRecoveries).values({
    roomId: f.roomId, workKind: "compaction", workId: f.claim.modelOperationId,
    rebuildGeneration: f.claim.acceptedPlan.rebuildGeneration, observedAttempt: 1,
    observedFailureAt: original.errorAt!, observedThrough: original.errorAt!,
    targetModelId: "surplus:operator-pin", authorizedBy: f.userId,
    authorizedAt: original.errorAt!,
  });
  await recovery().recoverJournal(input);
  expect((await readState(f.roomId)).binding).toEqual(f.binding);
  await db.delete(roomJournalModelRecoveries).where(eq(roomJournalModelRecoveries.roomId, f.roomId));

  await db.update(roomJournalState).set({
    compactionAcceptedPlan: { ...f.claim.acceptedPlan, previousRollupId: randomUUID() },
  }).where(eq(roomJournalState.roomId, f.roomId));
  await recovery().recoverJournal(input);
  expect((await readState(f.roomId)).binding).toEqual(f.binding);
  await db.update(roomJournalState).set({ compactionAcceptedPlan: f.claim.acceptedPlan })
    .where(eq(roomJournalState.roomId, f.roomId));

  expect(await db.transaction(tx => isCurrentOrdinaryCompactionAcceptedPlan(
    tx, f.roomId,
  ))).toBe(true);
  expect(await readRoomJournalCompactionServiceRecoveryPage(db, {
    modelId: NEW_MODEL, limit: 20,
  })).toHaveLength(1);

  await recovery().recoverJournal(input);

  const rebound = await readState(f.roomId);
  expect(rebound).toMatchObject({
    binding: { ...f.binding, modelId: NEW_MODEL },
    plan: original.plan,
    retryAfter: null,
    errorCode: original.errorCode,
    errorAt: original.errorAt,
    errorAttempt: original.errorAttempt,
    errorModelId: original.errorModelId,
  });
});

test("automatic compaction recovery preserves published, mixed, Human-funded, and unknown work", async () => {
  for (const outcome of ["mixed", "human", "unknown"] as const) {
    const f = await refusedCompaction(outcome);
    await db.insert(llmUsageEvents).values({
      roomId: f.roomId, occurredAt: NOW, callType: "room_event_compaction", model: OLD_MODEL,
      provider: "openai", providerRoute: outcome === "unknown" ? "direct" : "personal",
      fundingKind: outcome === "human" ? "personal" : "service",
      payerHumanId: outcome === "human" ? f.userId : null,
      credentialId: outcome === "human" ? randomUUID() : null,
      credentialRevision: outcome === "human" ? 1 : null,
      endpoint: "/v1/responses",
      attemptOutcome: outcome === "unknown" ? "unknown" : "failed",
      failureCode: outcome === "mixed" ? "provider_error" : outcome === "human" ? "no_sellers_for_model" : null,
      costState: "unknown", metadata: { operationId: f.claim.modelOperationId },
    });
    await recovery().recoverJournal({ now: NOW, limit: 20, signal: new AbortController().signal });
    expect((await readState(f.roomId)).binding).toEqual(f.binding);
  }

  const published = await refusedCompaction("published");
  await db.insert(roomEventRollups).values({
    roomId: published.roomId,
    throughEventSequence: published.claim.plan.throughEventSequence,
    content: "Already published compaction",
    sourceEventCount: published.claim.plan.selectedEvents.length,
    modelId: OLD_MODEL,
    compactorVersion: EXTRACTOR,
    createdAt: NOW,
  });
  await recovery().recoverJournal({ now: NOW, limit: 20, signal: new AbortController().signal });
  expect((await readState(published.roomId)).binding).toEqual(published.binding);
});
