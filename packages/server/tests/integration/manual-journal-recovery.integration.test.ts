import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  and,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  llmUsageEvents,
  namespaces,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  roomEvents,
  roomJournalBatches,
  roomJournalModelRecoveries,
  roomJournalState,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import {
  compactionModelExposureDependencies,
  extractionModelExposureDependencies,
  failCompaction,
  failExtraction,
  tryClaimCompactionRoom,
  tryClaimRoom,
  type CompactionClaim,
  type ExtractionClaim,
} from "@nautilo/runtime";
import { createStenographerMemoryFunding } from "../../src/lib/stenographer-memory-funding";
import { requestManualJournalRecovery } from "../../src/lib/request-manual-journal-recovery";

type Db = ReturnType<typeof createDirectDb>;
type Fixture = Readonly<{
  userId: string;
  userActorId: string;
  agentId: string;
  agentActorId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
  messageId: number;
  recordIds: string[];
}>;

let db: Db;
const fixtures: Fixture[] = [];
const BASE = new Date(Date.now() - 4 * 60_000);
const MODEL = "fixture:journal-service";
const RECOVERY_MODEL = "fixture:journal-recovery-service";

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(4);
});

afterAll(async () => {
  for (const fixture of fixtures.reverse()) {
    await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, fixture.roomId));
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, fixture.sessionId));
    await db.delete(sessions).where(eq(sessions.id, fixture.sessionId));
    await db.delete(roomMembers).where(eq(roomMembers.roomId, fixture.roomId));
    await db.delete(rooms).where(eq(rooms.id, fixture.roomId));
    if (fixture.recordIds.length > 0) {
      await db.update(reflectionRecords).set({ disposition: "purged" }).where(inArray(
        reflectionRecords.recordId,
        fixture.recordIds,
      ));
      await db.delete(reflectionRecordPayloadRepresentationHeads).where(inArray(
        reflectionRecordPayloadRepresentationHeads.recordId,
        fixture.recordIds,
      ));
      await db.delete(reflectionRecordPayloadRepresentations).where(inArray(
        reflectionRecordPayloadRepresentations.recordId,
        fixture.recordIds,
      ));
    }
    await db.delete(namespaces).where(eq(namespaces.id, fixture.namespaceId));
    await db.delete(actors).where(eq(actors.id, fixture.agentActorId));
    await db.delete(agents).where(eq(agents.id, fixture.agentId));
    await db.delete(actors).where(eq(actors.id, fixture.userActorId));
    await db.delete(users).where(eq(users.id, fixture.userId));
  }
  await db?.end();
}, 30_000);

async function fixture(label: string): Promise<Fixture> {
  const id = randomUUID();
  const [user] = await db.insert(users).values({
    name: `Journal recovery ${label}`,
    email: `journal-recovery-${id}@integration.test`,
  }).returning({ id: users.id });
  const [human] = await db.insert(actors).values({
    ownerId: user!.id, displayName: "Journal recovery operator", kind: "user",
  }).returning({ id: actors.id });
  const [agent] = await db.insert(agents).values({
    handle: `journal-recovery-${id}`,
  }).returning({ id: agents.id });
  const [agentActor] = await db.insert(actors).values({
    ownerId: user!.id, displayName: "Journal recovery Agent", kind: "agent",
    agentId: agent!.id,
  }).returning({ id: actors.id });
  const [namespace] = await db.insert(namespaces).values({
    scope: "private", label: `journal-recovery-${id}`,
  }).returning({ id: namespaces.id });
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
    threadId: `journal-recovery:${id}`, ownerId: user!.id, personaId: "owner",
    agentId: agent!.id, roomId, channel: "electron",
  }).returning({ id: sessions.id });
  const [message] = await db.insert(sessionMessages).values({
    sessionId: session!.id, role: "user", content: "Synthetic Journal evidence",
    fingerprint: `fp:v1:human:${id}`, createdAt: new Date(BASE.getTime() + 1_000),
  }).returning({ id: sessionMessages.id });
  await db.insert(roomJournalState).values({
    roomId, extractorVersion: "m219-v1", historicalBackfillStatus: "not_needed",
    createdAt: BASE, updatedAt: BASE,
  });
  const value = {
    userId: user!.id, userActorId: human!.id, agentId: agent!.id,
    agentActorId: agentActor!.id, namespaceId: namespace!.id,
    roomId, sessionId: session!.id, messageId: message!.id, recordIds: [],
  };
  fixtures.push(value);
  return value;
}

function funding(
  createInvoker: () => (prompt: string) => Promise<string>,
  humanId: string,
) {
  return createStenographerMemoryFunding({
    db,
    ports: {
      readRecord: (dependency) => Promise.resolve({
        recordRef: dependency.recordRef,
        lifecycle: "current",
        structuralHeight: 0,
        processingGeneration: dependency.observedProcessingGeneration,
        semantic: {
          observedContentFingerprint: `fixture:${dependency.recordRef}`,
          posture: "derived",
          statement: "Synthetic Journal evidence",
          sourceDependencies: [],
          anchors: [],
          childRecordRefs: [],
          producer: {
            producerRef: "stenographer",
            policyVersion: "manual-journal-recovery-fixture-v1",
          },
          terminalAuthorityLeafHandles: dependency.terminalAuthorityLeafHandles,
          modelExposureDependencies: [],
        },
      } satisfies DurableRecordEnvelope),
      readSource: () => Promise.resolve({
        status: "current", kind: "unknown",
        audienceHumanIds: [humanId], includesPublicBoundary: false,
      }),
      readAudience: () => Promise.resolve({
        humanIds: [humanId], includesPublicBoundary: false,
      }),
    },
    budget: { maxVisitedRecords: 256, maxTraversalWork: 1_024 },
    commitmentKey: new Uint8Array(32).fill(29),
    resolveServiceModel: () => MODEL,
    assertAvailable: () => Promise.resolve(),
    createInvoker: () => createInvoker(),
  });
}

async function recordUnknownAttempt(input: Readonly<{
  roomId: string;
  callType: "room_stenographer" | "room_event_compaction";
  operationId: string;
  modelId: string;
  at: Date;
}>): Promise<void> {
  await db.insert(llmUsageEvents).values({
    roomId: input.roomId, callType: input.callType, provider: "fixture",
    model: input.modelId, providerRoute: "fixture", fundingKind: "service",
    endpoint: "/v1/chat/completions", attemptOutcome: "succeeded",
    costState: "estimated", estimatedCostUsd: "0.01", occurredAt: input.at,
    metadata: { operationId: input.operationId },
  });
}

describe("manual Journal recovery on PostgreSQL", () => {
  test("rejects a disabled Human operator before assessing work", async () => {
    const f = await fixture("disabled-operator");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, f.userId));
    let rejected: unknown;
    try {
      await requestManualJournalRecovery({
        db,
        now: new Date(),
        observedThrough: new Date(),
        authorizedBy: f.userId,
        modelId: RECOVERY_MODEL,
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("Journal recovery authorizer is unavailable");
  });

  test("authorizes, deduplicates, claims, spends, and observation-fences extraction", async () => {
    const f = await fixture("extraction");
    const claimedAt = new Date(Date.now() - 60_000);
    const claim = await tryClaimRoom(db, f.roomId, claimedAt);
    if (!claim) throw new Error("expected extraction claim");
    await funding(() => async () => "unused", f.userId)
      .admitExtractionModel(claim, extractionModelExposureDependencies(claim));
    const failedAt = new Date(claimedAt.getTime() + 1_000);
    await recordUnknownAttempt({
      roomId: f.roomId, callType: "room_stenographer",
      operationId: claim.batchId, modelId: MODEL, at: failedAt,
    });
    await failExtraction({ claim, errorCode: "provider_outcome_unknown", modelId: MODEL, db, now: failedAt });

    const request = { db, now: new Date(failedAt.getTime() + 1_000), observedThrough: failedAt,
      authorizedBy: f.userId, modelId: RECOVERY_MODEL };
    expect(await requestManualJournalRecovery(request)).toEqual({ queued: 1, held: 0 });
    expect(await requestManualJournalRecovery(request)).toEqual({ queued: 0, held: 0 });
    const recovered = await tryClaimRoom(db, f.roomId, new Date(request.now.getTime() + 1_000));
    expect(recovered?.manualModelRecoveryId).toBeString();
    let calls = 0;
    const admitted = await funding(() => async () => (calls += 1, "[]"), f.userId)
      .admitExtractionModel(
        recovered as ExtractionClaim,
        extractionModelExposureDependencies(recovered as ExtractionClaim),
      );
    expect(admitted.modelId).toBe(RECOVERY_MODEL);
    await admitted.invoke("synthetic prompt");
    expect(calls).toBe(1);
    const [spent] = await db.select().from(roomJournalModelRecoveries).where(eq(
      roomJournalModelRecoveries.id,
      recovered!.manualModelRecoveryId!,
    ));
    expect(spent?.spentAt).not.toBeNull();

    const newerFailure = new Date(request.now.getTime() + 3_000);
    await recordUnknownAttempt({
      roomId: f.roomId, callType: "room_stenographer", operationId: claim.batchId,
      modelId: RECOVERY_MODEL, at: newerFailure,
    });
    await failExtraction({ claim: recovered!, errorCode: "provider_outcome_unknown",
      modelId: RECOVERY_MODEL, db, now: newerFailure });
    expect(await requestManualJournalRecovery({ ...request, now: new Date(newerFailure.getTime() + 1_000) }))
      .toEqual({ queued: 0, held: 0 });
    expect(await db.select().from(roomJournalModelRecoveries).where(eq(
      roomJournalModelRecoveries.roomId,
      f.roomId,
    ))).toHaveLength(1);
  }, 30_000);

  test("claims and spends an exact compaction hold without publishing twice", async () => {
    const f = await fixture("compaction");
    const [sourceBatch] = await db.insert(roomJournalBatches).values({
      roomId: f.roomId, fromMessageIdExclusive: 0,
      throughMessageIdInclusive: f.messageId, extractorVersion: "m219-v1",
      observationPublicationVersion: 2,
      status: "completed", attemptCount: 1, operationCount: 0,
      completedAt: BASE, createdAt: BASE,
    }).returning({ id: roomJournalBatches.id });
    f.recordIds.push(...Array.from({ length: 80 }, () => randomUUID()));
    const encoder = new TextEncoder();
    await db.transaction(async (tx) => {
      await tx.insert(reflectionRecords).values(f.recordIds.map(recordId => ({
        recordId,
        lifecycle: "current" as const,
        structuralHeight: 0,
        producerPolicyVersion: "manual-journal-recovery-fixture-v1",
        processingGeneration: 1,
        payloadVersion: 1,
        disposition: "available" as const,
        createdAt: BASE,
        updatedAt: BASE,
      })));
      await tx.insert(reflectionRecordPayloadRepresentations).values(
        f.recordIds.map((recordId, index) => ({
          recordId,
          representation: "ordinary" as const,
          representationGeneration: 1,
          payloadVersion: 1,
          plaintextPayloadBytes: encoder.encode(JSON.stringify({
            statement: `Synthetic compaction fact ${index + 1} ${"x".repeat(520)}`,
          })),
          createdAt: BASE,
        })),
      );
      await tx.insert(reflectionRecordPayloadRepresentationHeads).values(
        f.recordIds.map(recordId => ({
          recordId,
          representation: "ordinary" as const,
          currentRepresentationGeneration: 1,
          updatedAt: BASE,
        })),
      );
      await tx.execute(sql`
        SELECT set_config('nautilo.stenographer_writer_version', '2', true)
      `);
      await tx.insert(roomEvents).values(f.recordIds.map((recordId, index) => ({
        id: recordId,
        roomId: f.roomId,
        sequence: index + 1,
        kind: "fact" as const,
        statement: null,
        status: "active" as const,
        sourceMessageIds: [f.messageId],
        sourceBatchId: sourceBatch!.id,
        batchLocalOrdinal: index,
        extractorVersion: "m219-v1",
        projectionKind: "native" as const,
        recordId,
        nativeAttachedAt: BASE,
        createdAt: BASE,
      })));
    });
    const dueAt = new Date(Date.now() - 60_000);
    await db.update(roomJournalState).set({ compactionDueAt: dueAt })
      .where(eq(roomJournalState.roomId, f.roomId));
    const claim = await tryClaimCompactionRoom(db, f.roomId, dueAt);
    if (!claim) throw new Error("expected compaction claim");
    await funding(() => async () => "unused", f.userId)
      .admitCompactionModel(claim, compactionModelExposureDependencies(claim));
    const failedAt = new Date(dueAt.getTime() + 1_000);
    await recordUnknownAttempt({ roomId: f.roomId, callType: "room_event_compaction",
      operationId: claim.modelOperationId, modelId: MODEL, at: failedAt });
    await failCompaction({ claim, errorCode: "provider_outcome_unknown", modelId: MODEL, db, now: failedAt });
    const result = await requestManualJournalRecovery({
      db, now: new Date(failedAt.getTime() + 1_000), observedThrough: failedAt,
      authorizedBy: f.userId, modelId: RECOVERY_MODEL,
    });
    expect(result).toEqual({ queued: 1, held: 0 });
    const recovered = await tryClaimCompactionRoom(db, f.roomId, new Date(failedAt.getTime() + 2_000));
    expect(recovered?.manualModelRecoveryId).toBeString();
    let calls = 0;
    const admitted = await funding(() => async () => (calls += 1, "rollup"), f.userId)
      .admitCompactionModel(
        recovered as CompactionClaim,
        compactionModelExposureDependencies(recovered as CompactionClaim),
      );
    expect(admitted.modelId).toBe(RECOVERY_MODEL);
    await admitted.invoke("synthetic compaction prompt");
    let duplicate: unknown;
    try {
      await admitted.invoke("duplicate dispatch");
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(Error);
    expect((duplicate as Error).message).toContain("already dispatched");
    expect(calls).toBe(1);
    const [authorization] = await db.select().from(roomJournalModelRecoveries)
      .where(and(
        eq(roomJournalModelRecoveries.roomId, f.roomId),
        eq(roomJournalModelRecoveries.workKind, "compaction"),
      ));
    expect(authorization?.spentAt).not.toBeNull();
  }, 30_000);
});
