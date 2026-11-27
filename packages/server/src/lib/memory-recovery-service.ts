import {
  acquireRoomWriteLock, and, asc, eq, getEncryptionTransitionPolicy, gt, gte,
  hasOnlyRefusedServiceAttempts, inArray, isNotNull, isNull, llmUsageEvents, ne,
  readRoomJournalCompactionServiceRecoveryPage, readRoomJournalServiceRecoveryPage,
  rebindRoomJournalFailedBatchServiceModel, rebindRoomJournalFailedCompactionServiceModel,
  reflectionManualRecoveryFamilyKeySql, reflectionRecordSemanticWork,
  reflectionRecords, roomEvents, rooms, sql, lte,
  type DirectDatabase,
} from "@nautilo/db";
import { isCurrentOrdinaryCompactionAcceptedPlan, reflectionModelOperationId } from "@nautilo/runtime";
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
type ManualRecoveryDb = Pick<DirectDatabase, "select" | "selectDistinct" | "execute">;
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
  ).where(eq(reflectionRecordSemanticWork.acceptedModelBinding, binding))
    .orderBy(asc(reflectionRecordSemanticWork.recordId))
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

export function reflectionRecoveryAttemptIdentities(
  binding: Extract<MemoryOperationBinding, { kind: "service" }>,
) {
  return (["primary", "repair"] as const).map(wireKind => ({
    kind: "reflection_operation" as const,
    operationId: reflectionModelOperationId(binding, wireKind),
  }));
}

async function canRetryReflection(db: QueryDb, family: ReflectionFamily): Promise<boolean> {
  if (!reflectionFamilyEligible(family)) return false;
  return hasOnlyRefusedServiceAttempts(reflectionRecoveryAttemptIdentities(family.binding), db, {
    modelId: family.binding.modelId,
    occurredAtOrAfter: family.generationStartedAt,
  });
}

function familyCarriesManualRecovery(family: ReflectionFamily): boolean {
  return family.members.some(({ work }) => work.manualRecoveryId !== null);
}

export type ManualReflectionRefusalRecoveryPage = Readonly<{
  recordRefs: readonly string[];
  held: number;
  scanned: number;
  nextCursor?: string;
}>;

/**
 * Lock and prove a bounded page of spent manual Reflection families whose
 * exact old service operation was refused before the operator's new click.
 * The caller must consume these coordinates in the same transaction.
 */
export async function readManualReflectionRefusalRecoveryPage(
  db: ManualRecoveryDb,
  input: Readonly<{
    observedThrough: Date;
    after: string | null;
    limit: number;
  }>,
): Promise<ManualReflectionRefusalRecoveryPage> {
  if (!Number.isFinite(input.observedThrough.getTime())
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1) {
    throw new TypeError("Manual Reflection refusal recovery page is invalid");
  }
  const work = reflectionRecordSemanticWork;
  const familyKey = reflectionManualRecoveryFamilyKeySql(work);
  const seedEligibility = and(
    eq(work.state, "checkpointed"),
    eq(work.stage, "organization"),
    eq(work.waitingReason, "provider"),
    isNull(work.leaseToken),
    eq(work.acceptedModelBindingGeneration, work.generation),
    isNotNull(work.manualRecoveryId),
    isNotNull(work.manualRecoverySpentAt),
    lte(work.updatedAt, input.observedThrough),
    eq(sql<string>`${work.acceptedModelBinding}->>'kind'`, "service"),
    eq(sql<string>`${work.acceptedModelBinding}->>'role'`, "memoryReflection"),
  );
  const seedKeys = (await db.selectDistinct({ familyKey: familyKey.as("family_key") })
    .from(work)
    .where(and(
      seedEligibility,
      input.after === null ? undefined : gt(familyKey, input.after),
    ))
    .orderBy(asc(familyKey))
    .limit(input.limit))
    .map(row => row.familyKey);
  const recordRefs: string[] = [];
  let held = 0;
  for (const key of seedKeys) {
    const seedRows = await db.select().from(work).where(and(
      seedEligibility,
      eq(familyKey, key),
    )).orderBy(asc(work.recordId));
    const seed = seedRows[0];
    const proven = await (async (): Promise<readonly string[] | null> => {
      if (seed === undefined || seed.startedAt === null
        || seed.manualRecoveryAuthorizedAt === null) return null;
      const binding = eligibleReflectionBinding(seed);
      if (binding === null) return null;
      const latestPriorAttempt = new Date(input.observedThrough.getTime() - 1);
      if (!Number.isFinite(latestPriorAttempt.getTime())) return null;
      const refusalAfter = new Date(Math.max(
        seed.startedAt.getTime(),
        seed.manualRecoveryAuthorizedAt.getTime(),
      ));
      const operationIds = reflectionRecoveryAttemptIdentities(binding)
        .map(identity => identity.operationId);
      const [invocation] = await db.select({ roomId: llmUsageEvents.roomId })
        .from(llmUsageEvents).where(and(
          eq(llmUsageEvents.callType, "room_reflection"),
          inArray(sql<string>`${llmUsageEvents.metadata}->>'operationId'`, operationIds),
          eq(llmUsageEvents.model, binding.modelId),
          gte(llmUsageEvents.occurredAt, refusalAfter),
          lte(llmUsageEvents.occurredAt, latestPriorAttempt),
          isNotNull(llmUsageEvents.roomId),
        )).orderBy(asc(llmUsageEvents.occurredAt), asc(llmUsageEvents.id)).limit(1);
      if (invocation?.roomId === null || invocation?.roomId === undefined) return null;
      await acquireRoomWriteLock(db, invocation.roomId);
      const family = await readReflectionFamily(db, invocation.roomId, seed);
      if (family === null || !reflectionFamilyEligible(family)) return null;
      const recoveryId = family.members[0]?.work.manualRecoveryId;
      const safeManualFamily = typeof recoveryId === "string"
        && family.members.every(({ work: member }) =>
          member.manualRecoveryId === recoveryId
          && member.manualRecoverySourceGeneration === member.generation - 1
          && member.manualRecoveryServiceModelId === family.binding.modelId
          && member.manualRecoveryAuthorizedAt !== null
          && member.manualRecoveryAuthorizedAt < input.observedThrough
          && member.manualRecoverySpentAt !== null
          && member.manualRecoverySpentAt <= input.observedThrough
          && member.updatedAt <= input.observedThrough);
      if (!safeManualFamily) return null;
      const authorizedAfter = new Date(Math.max(
        family.generationStartedAt.getTime(),
        ...family.members.map(member => member.work.manualRecoveryAuthorizedAt!.getTime()),
      ));
      if (!await hasOnlyRefusedServiceAttempts(
        reflectionRecoveryAttemptIdentities(family.binding),
        db,
        {
          modelId: family.binding.modelId,
          occurredAtOrAfter: authorizedAfter,
          occurredAtOrBefore: latestPriorAttempt,
        },
      )) return null;
      return family.members.map(member => member.work.recordId);
    })();
    if (proven === null) held += seedRows.length;
    else recordRefs.push(...proven);
  }
  const nextCursor = seedKeys.length === input.limit ? seedKeys.at(-1) : undefined;
  return {
    recordRefs,
    held,
    scanned: seedKeys.length,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
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
    if (!family || !await canRetryReflection(tx, family)) return;
    if (familyCarriesManualRecovery(family)) return;
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
  let journalCompactionAfter: string | undefined;
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
      const compactions = await readRoomJournalCompactionServiceRecoveryPage(db, {
        modelId, limit: input.limit,
        ...(journalCompactionAfter === undefined ? {} : { after: journalCompactionAfter }),
      });
      for (const candidate of compactions) {
        if (input.signal.aborted || options.resolveJournalModel() !== modelId) return;
        await rebindRoomJournalFailedCompactionServiceModel(
          db,
          { ...candidate, modelId, now: input.now },
          (tx, current) => isCurrentOrdinaryCompactionAcceptedPlan(
            tx,
            current.roomId,
          ),
        );
        journalCompactionAfter = candidate.roomId;
      }
      if (compactions.length < input.limit) journalCompactionAfter = undefined;
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
