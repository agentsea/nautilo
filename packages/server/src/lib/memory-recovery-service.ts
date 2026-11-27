import {
  acquireRoomWriteLock, and, asc, eq, getEncryptionTransitionPolicy, gt, gte,
  hasOnlyRefusedServiceAttempts, inArray, isNotNull, isNull, llmUsageEvents, ne,
  readRoomJournalServiceRecoveryPage, rebindRoomJournalFailedBatchServiceModel,
  reflectionRecordSemanticWork, reflectionRecords, roomEvents, rooms, sql,
  type DirectDatabase,
} from "@nautilo/db";
import { reflectionModelOperationId } from "@nautilo/runtime";
import { parseMemoryOperationBinding, type MemoryOperationBinding } from "@nautilo/types";

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
  roomAssociationProven: boolean;
}>;
type QueryDb = Pick<DirectDatabase, "select">;
function eligibleReflectionBinding(work: ReflectionWork): Extract<MemoryOperationBinding, { kind: "service" }> | null {
  const binding = reflectionServiceBinding(work);
  return binding !== null && work.state === "checkpointed" && work.stage === "organization" && work.waitingReason === "provider"
    && work.leaseToken === null
    && work.completionOutcome !== "provider_outcome_unknown"
    ? binding : null;
}

function reflectionServiceBinding(work: ReflectionWork): Extract<MemoryOperationBinding, { kind: "service" }> | null {
  if (work.acceptedModelBindingGeneration !== work.generation) return null;
  try {
    const binding = parseMemoryOperationBinding(work.acceptedModelBinding);
    return binding.kind === "service" && binding.role === "memoryReflection" ? binding : null;
  } catch {
    return null;
  }
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
): Promise<ReflectionFamily | null> {
  const binding = reflectionServiceBinding(seed);
  if (!binding) return null;
  const members = await db.select({
    work: reflectionRecordSemanticWork,
    disposition: reflectionRecords.disposition,
  }).from(reflectionRecordSemanticWork).innerJoin(
    reflectionRecords,
    eq(reflectionRecords.recordId, reflectionRecordSemanticWork.recordId),
  ).where(eq(
    sql<string>`${reflectionRecordSemanticWork.acceptedModelBinding}->>'inputCommitment'`,
    binding.inputCommitment,
  )).orderBy(asc(reflectionRecordSemanticWork.recordId))
    .for("update", { of: reflectionRecordSemanticWork });
  if (members.length === 0 || !members.some(member => member.work.recordId === seed.recordId)) return null;
  const recordIds = members.map(member => member.work.recordId);
  const eventAssociations = await db.select({
    recordId: roomEvents.recordId,
    roomId: roomEvents.roomId,
  }).from(roomEvents).where(inArray(roomEvents.recordId, recordIds))
    .orderBy(asc(roomEvents.recordId), asc(roomEvents.roomId), asc(roomEvents.id));
  const operationIds = (["primary", "repair"] as const).map(wireKind =>
    reflectionModelOperationId(binding, wireKind));
  const attempts = await db.select({
    roomId: llmUsageEvents.roomId,
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

async function recoverReflectionFamily(
  db: DirectDatabase,
  seed: ReflectionWork,
  modelId: string,
  now: Date,
): Promise<void> {
  const previous = eligibleReflectionBinding(seed);
  if (!previous || previous.modelId === modelId || seed.startedAt === null) return;

  // The invocation supplies the accounting Room. The transaction proves its
  // relationship to every Record and all primary and repair attempts again.
  const [invocation] = await db.select({ roomId: llmUsageEvents.roomId }).from(llmUsageEvents)
    .where(and(
      eq(llmUsageEvents.callType, "room_reflection"),
      eq(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, reflectionModelOperationId(previous, "primary")),
      eq(llmUsageEvents.model, previous.modelId),
      gte(llmUsageEvents.occurredAt, seed.startedAt),
      isNotNull(llmUsageEvents.roomId),
    )).orderBy(asc(llmUsageEvents.occurredAt), asc(llmUsageEvents.id)).limit(1);
  const roomId = invocation?.roomId;
  if (!roomId) return;

  await db.transaction(async tx => {
    await acquireRoomWriteLock(tx, roomId);
    const [room] = await tx.select({ id: rooms.id }).from(rooms)
      .where(and(eq(rooms.id, roomId), isNull(rooms.archivedAt))).limit(1);
    if (!room) return;
    const family = await readReflectionFamily(tx, roomId, seed);
    if (!family || !await canRetryReflection(tx, roomId, family)) return;
    await tx.update(reflectionRecordSemanticWork).set({
      acceptedModelBinding: { ...family.binding, modelId },
      nextAttemptAt: now,
      updatedAt: now,
      waitingReason: null,
    }).where(inArray(
      reflectionRecordSemanticWork.recordId,
      family.members.map(member => member.work.recordId),
    ));
  });
}

/** Recovery runs inside each enabled worker's normal maintenance-gated poll. */
export function createAutomaticMemoryRecovery(options: Readonly<{
  db(): DirectDatabase;
  resolveJournalModel(): string;
  resolveReflectionModel(): string;
}>) {
  let journalAfter: string | undefined;
  let reflectionAfter: string | undefined;

  return {
    async recoverJournal(input: Readonly<{ now: Date; limit: number; signal: AbortSignal }>) {
      if (input.signal.aborted) return;
      const db = options.db();
      if ((await getEncryptionTransitionPolicy(db)).mode !== "plaintext_only") return;
      const modelId = options.resolveJournalModel();
      const page = await readRoomJournalServiceRecoveryPage(db, {
        modelId, limit: input.limit,
        ...(journalAfter === undefined ? {} : { after: journalAfter }),
      });
      for (const candidate of page) {
        if (input.signal.aborted || options.resolveJournalModel() !== modelId) return;
        await rebindRoomJournalFailedBatchServiceModel(db, { ...candidate, modelId, now: input.now });
        journalAfter = candidate.batchId;
      }
      if (page.length < input.limit) journalAfter = undefined;
    },

    async recoverReflection(input: Readonly<{ now: Date; limit: number; signal: AbortSignal }>) {
      if (input.signal.aborted) return;
      const db = options.db();
      if ((await getEncryptionTransitionPolicy(db)).mode !== "plaintext_only") return;
      const modelId = options.resolveReflectionModel();
      const page = await db.select().from(reflectionRecordSemanticWork).where(and(
        eq(reflectionRecordSemanticWork.state, "checkpointed"),
        eq(reflectionRecordSemanticWork.stage, "organization"),
        eq(reflectionRecordSemanticWork.waitingReason, "provider"),
        isNull(reflectionRecordSemanticWork.leaseToken),
        eq(reflectionRecordSemanticWork.acceptedModelBindingGeneration, reflectionRecordSemanticWork.generation),
        eq(sql<string>`${reflectionRecordSemanticWork.acceptedModelBinding}->>'kind'`, "service"),
        ne(sql<string>`${reflectionRecordSemanticWork.acceptedModelBinding}->>'modelId'`, modelId),
        reflectionAfter === undefined ? undefined : gt(reflectionRecordSemanticWork.recordId, reflectionAfter),
      )).orderBy(asc(reflectionRecordSemanticWork.recordId)).limit(input.limit);
      const seen = new Set<string>();
      for (const seed of page) {
        if (input.signal.aborted || options.resolveReflectionModel() !== modelId) return;
        const commitment = eligibleReflectionBinding(seed)?.inputCommitment;
        if (commitment !== undefined && !seen.has(commitment)) {
          seen.add(commitment);
          await recoverReflectionFamily(db, seed, modelId, input.now);
        }
        reflectionAfter = seed.recordId;
      }
      if (page.length < input.limit) reflectionAfter = undefined;
    },
  };
}
