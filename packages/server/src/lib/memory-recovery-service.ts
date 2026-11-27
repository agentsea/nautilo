import { createHash } from "node:crypto";
import { getEligibleModels } from "@nautilo/agent";
import {
  acquireRoomWriteLock, and, asc, desc, eq, getEncryptionTransitionPolicy,
  hasOnlyRefusedServiceAttempts, inArray, isNull, llmUsageEvents,
  memoryReviewReceipts, memoryReviewTurns, ne, or, reflectionRecordSemanticWork,
  reflectionRecords, roomEvents, rooms, sql, type DirectDatabase,
  previewRoomJournalRecovery, previewRoomJournalServiceModelRebind, queueRoomJournalRecovery,
  readRoomJournalRecoveryMetadata, rebindRoomJournalFailedBatchServiceModel,
  type RoomJournalRecoveryMetadata,
} from "@nautilo/db";
import { reflectionModelOperationId } from "@nautilo/runtime";
import type { MemoryOperationBinding, MemoryRecoveryJob, MemoryRecoveryModel, MemoryRecoveryPreview, MemoryRecoveryRequest, MemoryRecoveryResult } from "@nautilo/types";

const JOBS_PER_PREVIEW = 20;
type ReflectionWork = typeof reflectionRecordSemanticWork.$inferSelect;
type ReflectionDisposition = typeof reflectionRecords.$inferSelect["disposition"];
type ReflectionFamilyMember = Readonly<{
  work: ReflectionWork;
  disposition: ReflectionDisposition;
}>;
type ReflectionFamily = Readonly<{
  members: readonly ReflectionFamilyMember[];
  binding: Extract<MemoryOperationBinding, { kind: "service" }>;
  generationStartedAt: Date;
  eventAssociations: readonly Readonly<{ id: string; recordId: string | null; roomId: string }>[];
  attempts: readonly Readonly<{ id: string; roomId: string | null; occurredAt: Date }>[];
  roomAssociationProven: boolean;
}>;
type QueryDb = Pick<DirectDatabase, "select">;
type Result = MemoryRecoveryResult["status"];

interface RecoveryServiceOptions {
  db(): DirectDatabase;
  readReviewJobs(roomId: string, now: Date, limit: number): Promise<MemoryRecoveryJob[]>;
  retryReview(input: { roomId: string; headTurnId: string; expectedVersion: string; modelId?: string; now: Date }): Promise<Result>;
  reconcileReview(input: { roomId: string; headTurnId: string; expectedVersion: string; authorizedBy: string; now: Date }): Promise<Result>;
}

function versionOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function reflectionVersion(family: ReflectionFamily): string {
  return versionOf([
    family.members.map(({ work, disposition }) => [work, disposition]),
    family.eventAssociations,
    family.attempts,
  ]);
}

function journalVersion(metadata: RoomJournalRecoveryMetadata): string {
  return versionOf([metadata.roomId, metadata.rebuildGeneration, metadata.lastProcessedMessageId,
    metadata.latestUnfinishedFailedExtractionBatch]);
}

async function readJournal(db: DirectDatabase, roomId: string, now: Date) {
  const metadata = await readRoomJournalRecoveryMetadata(db, roomId);
  const jobs: MemoryRecoveryJob[] = [];
  if (!metadata) {
    return { journal: { generation: 0, cursor: 0, lastCompletedAt: null, target: null, rebuild: "unavailable" as const }, jobs };
  }
  const generation = metadata.rebuildGeneration;
  const [rebuild, retry] = await Promise.all([
    previewRoomJournalRecovery(db, {
      roomId,
      expectedRebuildGeneration: generation,
      expectedCursor: metadata.lastProcessedMessageId,
      now,
    }),
    metadata.latestUnfinishedFailedExtractionBatch === null ? null
      : previewRoomJournalServiceModelRebind(db, {
        roomId, batchId: metadata.latestUnfinishedFailedExtractionBatch.id,
        expectedRebuildGeneration: generation,
        expectedAttemptCount: metadata.latestUnfinishedFailedExtractionBatch.attemptCount, now,
      }),
  ]);
  const batch = metadata.latestUnfinishedFailedExtractionBatch;
  if (batch) {
    jobs.push({
      id: batch.id, version: journalVersion(metadata), lane: "stenographer", stage: `${batch.lane} extraction`,
      reason: batch.errorCode ?? "unknown", modelId: batch.modelId,
      action: retry?.status === "allowed" ? "retry_with_model" : "blocked",
    });
  }
  if (metadata.lastCompactionErrorCode) {
    jobs.push({
      id: roomId, version: versionOf([roomId, metadata.lastCompactionErrorAt]), lane: "stenographer",
      stage: "compaction", reason: metadata.lastCompactionErrorCode, modelId: metadata.lastCompactionErrorModelId, action: "blocked",
    });
  }
  return { journal: {
    generation, cursor: metadata.lastProcessedMessageId, lastCompletedAt: metadata.lastExtractionCompletedAt?.toISOString() ?? null,
    target: metadata.rebuildTargetMessageId,
    rebuild: metadata.rebuildRequestedAt !== null ? "running" as const
      : rebuild.status === "allowed" ? "available" as const : "blocked" as const,
  }, jobs };
}

async function retryJournal(
  db: DirectDatabase, input: Extract<MemoryRecoveryRequest, { action: "retry_with_model" }>, now: Date,
): Promise<Result> {
  const metadata = await readRoomJournalRecoveryMetadata(db, input.roomId);
  const batch = metadata?.latestUnfinishedFailedExtractionBatch;
  if (!metadata || batch?.id !== input.jobId || journalVersion(metadata) !== input.version) return "stale";
  if (!batch.modelId) return "blocked";
  const result = await rebindRoomJournalFailedBatchServiceModel(db, {
    roomId: input.roomId, batchId: batch.id, expectedAttemptCount: batch.attemptCount,
    expectedRebuildGeneration: metadata.rebuildGeneration, expectedCurrentModelId: batch.modelId,
    modelId: input.modelId, now,
  });
  return result.status;
}

function reflectionRoom(db: QueryDb, roomId: string) {
  const currentEvent = db.select({ recordId: roomEvents.recordId }).from(roomEvents).where(eq(roomEvents.roomId, roomId));
  // A derived organizer Record can lack a Journal leaf. The exact primary
  // attempt retains the Room used for its invocation without opening payloads.
  const roomAttempt = db.select({ id: llmUsageEvents.id }).from(llmUsageEvents).where(and(
    eq(llmUsageEvents.roomId, roomId),
    eq(llmUsageEvents.callType, "room_reflection"),
    eq(
      sql<string>`${llmUsageEvents.metadata}->>'operationId'`,
      sql<string>`'reflection:' || (${reflectionRecordSemanticWork.acceptedModelBinding}->>'inputCommitment') || ':primary'`,
    ),
  ));
  return or(inArray(reflectionRecordSemanticWork.recordId, currentEvent), sql`exists (${roomAttempt})`);
}

function eligibleReflectionBinding(work: ReflectionWork): Extract<MemoryOperationBinding, { kind: "service" }> | null {
  const binding = work.acceptedModelBinding;
  return binding?.kind === "service" && binding.role === "memoryReflection"
    && work.state === "checkpointed" && work.stage === "organization" && work.waitingReason === "provider"
    && work.leaseToken === null && work.acceptedModelBindingGeneration === work.generation
    && work.completionOutcome !== "provider_outcome_unknown"
    ? binding : null;
}

function reflectionServiceBinding(work: ReflectionWork): Extract<MemoryOperationBinding, { kind: "service" }> | null {
  const binding = work.acceptedModelBinding;
  return binding?.kind === "service" && binding.role === "memoryReflection"
    && work.acceptedModelBindingGeneration === work.generation ? binding : null;
}

export function reflectionRecoveryFamilyRoomProven(input: Readonly<{
  roomId: string;
  memberRecordIds: readonly string[];
  eventAssociations: readonly Readonly<{ recordId: string | null; roomId: string }>[];
  attemptRoomIds: readonly (string | null)[];
}>): boolean {
  const eventRooms = new Map<string, Set<string>>();
  for (const event of input.eventAssociations) {
    if (event.recordId === null) continue;
    const roomsForRecord = eventRooms.get(event.recordId) ?? new Set<string>();
    roomsForRecord.add(event.roomId);
    eventRooms.set(event.recordId, roomsForRecord);
  }
  const attemptsBelongToRoom = input.attemptRoomIds.length > 0
    && input.attemptRoomIds.every(roomId => roomId === input.roomId);
  const allMembersBelongToRoom = input.memberRecordIds.every(recordId => {
    const roomsForRecord = eventRooms.get(recordId);
    return roomsForRecord?.size === 1 && roomsForRecord.has(input.roomId);
  });
  // Derived singleton work can lack a current Journal leaf. Its exact retained
  // invocation is the only content-free Room authority available to recovery.
  const syntheticSingleton = input.memberRecordIds.length === 1
    && input.eventAssociations.length === 0
    && attemptsBelongToRoom;
  return attemptsBelongToRoom && (allMembersBelongToRoom || syntheticSingleton);
}

async function readReflectionFamily(
  db: QueryDb,
  roomId: string,
  seed: ReflectionWork,
  lock: boolean,
): Promise<ReflectionFamily | null> {
  const binding = reflectionServiceBinding(seed);
  if (!binding) return null;
  const query = db.select({
    work: reflectionRecordSemanticWork,
    disposition: reflectionRecords.disposition,
  }).from(reflectionRecordSemanticWork).innerJoin(
    reflectionRecords,
    eq(reflectionRecords.recordId, reflectionRecordSemanticWork.recordId),
  ).where(eq(
    sql<string>`${reflectionRecordSemanticWork.acceptedModelBinding}->>'inputCommitment'`,
    binding.inputCommitment,
  )).orderBy(asc(reflectionRecordSemanticWork.recordId));
  const members = lock
    ? await query.for("update", { of: reflectionRecordSemanticWork })
    : await query;
  if (members.length === 0 || !members.some(member => member.work.recordId === seed.recordId)) return null;
  const recordIds = members.map(member => member.work.recordId);
  const eventAssociations = await db.select({
    id: roomEvents.id,
    recordId: roomEvents.recordId,
    roomId: roomEvents.roomId,
  }).from(roomEvents).where(inArray(roomEvents.recordId, recordIds))
    .orderBy(asc(roomEvents.recordId), asc(roomEvents.roomId), asc(roomEvents.id));
  const operationIds = (["primary", "repair"] as const).map(wireKind =>
    reflectionModelOperationId(binding, wireKind));
  const attempts = await db.select({
    id: llmUsageEvents.id,
    roomId: llmUsageEvents.roomId,
    occurredAt: llmUsageEvents.occurredAt,
  }).from(llmUsageEvents).where(and(
    eq(llmUsageEvents.callType, "room_reflection"),
    inArray(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, operationIds),
  )).orderBy(asc(llmUsageEvents.occurredAt), asc(llmUsageEvents.id));
  const startedAt = members.map(member => member.work.startedAt);
  if (startedAt.some(value => value === null)) return null;
  return {
    members,
    binding,
    // The shared provider operation cannot precede the last member joining its
    // current generation, so older receipts must not prove this family retry.
    generationStartedAt: new Date(Math.max(...startedAt.map(value => value!.getTime()))),
    eventAssociations,
    attempts,
    roomAssociationProven: reflectionRecoveryFamilyRoomProven({
      roomId,
      memberRecordIds: recordIds,
      eventAssociations,
      attemptRoomIds: attempts.map(attempt => attempt.roomId),
    }),
  };
}

function reflectionFamilyEligible(family: ReflectionFamily): boolean {
  return family.roomAssociationProven && family.members.every(({ work, disposition }) => {
    const binding = eligibleReflectionBinding(work);
    return disposition === "available" && binding !== null
      && JSON.stringify(binding) === JSON.stringify(family.binding);
  });
}

async function canRetryReflection(db: QueryDb, roomId: string, family: ReflectionFamily): Promise<boolean> {
  if (!reflectionFamilyEligible(family)) return false;
  return hasOnlyRefusedServiceAttempts((["primary", "repair"] as const).map(wireKind => ({
    kind: "operation", roomId, callType: "room_reflection",
    operationId: reflectionModelOperationId(family.binding, wireKind),
  })), db, {
    modelId: family.binding.modelId,
    occurredAtOrAfter: family.generationStartedAt,
  });
}

async function retryReflection(
  db: DirectDatabase, input: Extract<MemoryRecoveryRequest, { action: "retry_with_model" }>, now: Date,
): Promise<Result> {
  return db.transaction(async tx => {
    await acquireRoomWriteLock(tx, input.roomId);
    const [seed] = await tx.select().from(reflectionRecordSemanticWork)
      .where(eq(reflectionRecordSemanticWork.recordId, input.jobId)).limit(1);
    if (!seed) return "stale";
    const family = await readReflectionFamily(tx, input.roomId, seed, true);
    if (!family || family.members[0]?.work.recordId !== input.jobId
      || reflectionVersion(family) !== input.version) return "stale";
    if (family.binding.modelId === input.modelId
      || !await canRetryReflection(tx, input.roomId, family)) return "blocked";
    const updated = await tx.update(reflectionRecordSemanticWork).set({
      acceptedModelBinding: { ...family.binding, modelId: input.modelId },
      nextAttemptAt: now, updatedAt: now, waitingReason: null,
    }).where(inArray(
      reflectionRecordSemanticWork.recordId,
      family.members.map(member => member.work.recordId),
    )).returning({ recordId: reflectionRecordSemanticWork.recordId });
    if (updated.length !== family.members.length) {
      throw new Error("Reflection recovery family update lost atomicity");
    }
    return "queued";
  });
}

function reflectionFamilyReason(family: ReflectionFamily): string {
  const reasons = [...new Set(family.members.map(({ work }) =>
    work.failureDetail ?? work.failureCode ?? work.waitingReason ?? work.completionOutcome ?? work.state))];
  return reasons.join(", ");
}

function recoveryModels(): MemoryRecoveryModel[] {
  const toolModels = new Set(getEligibleModels({ purpose: "chat-tools" }).map(model => model.id));
  return getEligibleModels({ purpose: "chat" }).map(model => ({
    id: model.id, label: model.displayName,
    lanes: toolModels.has(model.id) ? ["stenographer", "reflection", "memory"] : ["stenographer", "reflection"],
  }));
}

export function createMemoryRecoveryService(options: RecoveryServiceOptions) {
  return {
    async preview(roomId: string): Promise<MemoryRecoveryPreview | null> {
      const db = options.db();
      const [room] = await db.select({ roomId: rooms.id, archivedAt: rooms.archivedAt })
        .from(rooms).where(eq(rooms.id, roomId)).limit(1);
      if (!room) return null;
      const now = new Date();
      const limit = JOBS_PER_PREVIEW + 1;
      const [policy, journal, review, reflection, reflected, reviewed, successfulReview] = await Promise.all([
        getEncryptionTransitionPolicy(db),
        readJournal(db, roomId, now),
        options.readReviewJobs(roomId, now, limit),
        db.select().from(reflectionRecordSemanticWork).where(and(
          reflectionRoom(db, roomId),
          or(eq(reflectionRecordSemanticWork.waitingReason, "provider"),
            ne(reflectionRecordSemanticWork.state, "complete"),
            eq(reflectionRecordSemanticWork.completionOutcome, "provider_outcome_unknown")),
        )).orderBy(asc(reflectionRecordSemanticWork.dueSince), asc(reflectionRecordSemanticWork.recordId)).limit(limit),
        db.select({
          completed: sql<number>`count(*) filter (where ${reflectionRecordSemanticWork.state} = 'complete'
            and ${reflectionRecordSemanticWork.completionOutcome} <> 'provider_outcome_unknown')::integer`,
          pending: sql<number>`count(*) filter (where ${reflectionRecordSemanticWork.state} <> 'complete')::integer`,
        }).from(reflectionRecordSemanticWork).where(reflectionRoom(db, roomId)),
        db.select({
          pending: sql<number>`count(*) filter (where ${memoryReviewTurns.state} <> 'covered')::integer`,
          covered: sql<number>`count(*) filter (where ${memoryReviewTurns.state} = 'covered')::integer`,
        }).from(memoryReviewTurns).where(eq(memoryReviewTurns.roomId, roomId)),
        db.select({ counts: memoryReviewReceipts.counts }).from(memoryReviewReceipts).where(and(
          eq(memoryReviewReceipts.outcome, "published"),
          inArray(memoryReviewReceipts.id, db.select({ id: memoryReviewTurns.receiptId }).from(memoryReviewTurns)
            .where(and(eq(memoryReviewTurns.roomId, roomId), eq(memoryReviewTurns.state, "covered")))),
        )).orderBy(desc(memoryReviewReceipts.createdAt)).limit(1),
      ]);
      const ordinary = policy.mode === "plaintext_only" && room.archivedAt === null;
      const reflectionJobs: MemoryRecoveryJob[] = [];
      const seenReflectionFamilies = new Set<string>();
      for (const work of reflection) {
        const binding = reflectionServiceBinding(work);
        const familyKey = binding?.inputCommitment ?? `record:${work.recordId}`;
        if (seenReflectionFamilies.has(familyKey)) continue;
        seenReflectionFamilies.add(familyKey);
        const family = binding === null ? null : await readReflectionFamily(db, roomId, work, false);
        if (family === null) {
          reflectionJobs.push({
            id: work.recordId,
            lane: "reflection",
            version: versionOf([work]),
            stage: work.stage,
            reason: work.failureDetail ?? work.failureCode ?? work.waitingReason ?? work.completionOutcome ?? work.state,
            modelId: work.acceptedModelBinding?.modelId ?? null,
            action: "blocked",
          });
          continue;
        }
        const head = family.members[0]!.work;
        reflectionJobs.push({
          id: head.recordId,
          lane: "reflection",
          version: reflectionVersion(family),
          stage: family.members.length > 1
            ? `${head.stage} (${family.members.length} Records)`
            : head.stage,
          reason: reflectionFamilyReason(family),
          modelId: family.binding.modelId,
          action: ordinary && await canRetryReflection(db, roomId, family)
            ? "retry_with_model"
            : "blocked",
        });
      }
      const jobs = [...journal.jobs, ...review, ...reflectionJobs];
      const counts = successfulReview[0]?.counts;
      return {
        roomId, generatedAt: now.toISOString(),
        journal: ordinary || journal.journal.rebuild !== "available"
          ? journal.journal : { ...journal.journal, rebuild: "blocked" },
        reflection: reflected[0] ?? { pending: 0, completed: 0 },
        memory: {
          ...(reviewed[0] ?? { pending: 0, covered: 0 }),
          latestOutcome: counts === undefined ? null : Object.values(counts).some(value => value > 0) ? "published" : "no_change",
        },
        jobs: jobs.slice(0, JOBS_PER_PREVIEW).map(job => ordinary ? job : { ...job, action: "blocked" }),
        hasMoreJobs: jobs.length > JOBS_PER_PREVIEW,
        models: ordinary && jobs.some(job => job.action === "retry_with_model") ? recoveryModels() : [],
      };
    },
    async run(input: MemoryRecoveryRequest, authorizedBy: string): Promise<MemoryRecoveryResult> {
      const db = options.db();
      if ((await getEncryptionTransitionPolicy(db)).mode !== "plaintext_only") return { status: "blocked" };
      const [room] = await db.select({ id: rooms.id }).from(rooms).where(and(
        eq(rooms.id, input.roomId), isNull(rooms.archivedAt),
      )).limit(1);
      if (!room) return { status: "stale" };
      const now = new Date();
      switch (input.action) {
        case "rebuild_journal":
          return { status: (await queueRoomJournalRecovery(db, {
            roomId: input.roomId,
            expectedRebuildGeneration: input.generation,
            expectedCursor: input.cursor,
            now,
          })).status };
        case "reconcile_review":
          return { status: await options.reconcileReview({
            roomId: input.roomId, headTurnId: input.jobId, expectedVersion: input.version, authorizedBy, now,
          }) };
        case "retry_review":
          return { status: await options.retryReview({
            roomId: input.roomId, headTurnId: input.jobId, expectedVersion: input.version, now,
          }) };
        case "retry_with_model":
          if (!recoveryModels().some(model => model.id === input.modelId && model.lanes.includes(input.lane))) {
            return { status: "blocked" };
          }
          if (input.lane === "reflection") return { status: await retryReflection(db, input, now) };
          if (input.lane === "stenographer") {
            return { status: await retryJournal(db, input, now) };
          }
          return { status: await options.retryReview({
            roomId: input.roomId, headTurnId: input.jobId, expectedVersion: input.version, modelId: input.modelId, now,
          }) };
      }
    },
  };
}
