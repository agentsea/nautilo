import {
  actors, and, backgroundCryptoAuthorizationRequests, eq, exists, getEncryptionTransitionPolicy, gte, inArray,
  isNotNull, isNull, lte, notExists, notInArray, or, reflectionRecordPayloadRepresentationHeads,
  roomEventRollups, roomEvents, roomJournalBatches, roomJournalState, roomMembers, rooms, sessionMessages, sessions, sql,
  type DirectDatabase,
} from "@nautilo/db";
import type {StenographerProtectionStatus} from "@nautilo/types";
import {assertVerifiedCryptoPostgresHandle, cryptoTypedDb, executeTypedCryptoQuery, type CryptoPostgresHandle} from "../storage/postgres-lattice-storage.ts";

const EXECUTION_KINDS = ["stenographer.extraction", "stenographer.historical", "stenographer.rebuild", "stenographer.compaction"] as const;
const KINDS = [...EXECUTION_KINDS, "stenographer.publication_reconcile", "stenographer.output_repair"];
const COUNT = sql<string>`COUNT(*)::text`.as("count");

function exactCount(value: unknown): string {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/u.test(text)) throw new TypeError("Invalid Stenographer status count");
  return text;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new TypeError("Invalid Stenographer status time");
  return date.toISOString();
}
function oldest(values: readonly (string | null)[]): string | null {
  return values.reduce<string | null>((result, value) => value !== null && (result === null || value < result) ? value : result, null);
}

/** Content-free facts from their existing owners. Never open a grant, body or
 * ciphertext to render health; a protected mapping is not a verified result. */
export async function readPostgresStenographerProtectionStatus(input: Readonly<{
  product: DirectDatabase; crypto: CryptoPostgresHandle; now: Date; since: Date; until: Date;
}>): Promise<StenographerProtectionStatus> {
  assertVerifiedCryptoPostgresHandle(input.crypto);
  const {product, now, since, until} = input;
  if (![now, since, until].every(value => Number.isFinite(value.getTime())) || since > until || until > now) {
    throw new TypeError("Invalid Stenographer status window");
  }
  const policy = await getEncryptionTransitionPolicy(product);
  const q = backgroundCryptoAuthorizationRequests;
  const queueRows = await executeTypedCryptoQuery(input.crypto, cryptoTypedDb.select({
    state: q.state, work_kind: q.workKind,
    count: COUNT,
    oldest_at: sql<string | null>`MIN(${q.createdAt})::text`.as("oldest_at"),
  }).from(q).where(and(eq(q.formatVersion, 2), eq(q.credentialSubjectKind, "processor"), inArray(q.workKind, KINDS),
    eq(q.expectedPolicyRevision, policy.revision), sql`${policy.mode !== "plaintext_only"}`,
    inArray(q.state, ["awaiting_recipient", "awaiting_device", "grant_ready", "claimed", "running", "publication_reconciliation"])))
    .groupBy(q.state, q.workKind));
  const completedRows = await executeTypedCryptoQuery(input.crypto, cryptoTypedDb.select({
    state: q.state, work_kind: q.workKind, count: COUNT,
  }).from(q).where(and(eq(q.formatVersion, 2), eq(q.credentialSubjectKind, "processor"), inArray(q.workKind, KINDS),
    inArray(q.state, ["completed", "cancelled", "terminal_failure"]), gte(q.finishedAt, since), lte(q.finishedAt, until)))
    .groupBy(q.state, q.workKind));
  const queue = {
    current: {awaitingRecipient: "0", waitingForDevice: "0", grantReady: "0", claimed: "0", running: "0", publicationReconciliation: "0", oldestWaitingAt: null as string | null},
    last24h: {protectedCompleted: "0", outputRepairCompleted: "0", cancelled: "0", terminalFailures: "0"},
  };
  const currentFields = {awaiting_recipient: "awaitingRecipient", awaiting_device: "waitingForDevice", grant_ready: "grantReady",
    claimed: "claimed", running: "running", publication_reconciliation: "publicationReconciliation"} as const;
  for (const row of queueRows) {
    const field = currentFields[row.state as keyof typeof currentFields];
    if (field === undefined) throw new TypeError("Invalid Stenographer queue state");
    queue.current[field] = (BigInt(queue.current[field]) + BigInt(exactCount(row.count))).toString();
    if (row.state === "awaiting_device" || row.state === "awaiting_recipient") {
      queue.current.oldestWaitingAt = oldest([queue.current.oldestWaitingAt, timestamp(row.oldest_at)]);
    }
  }
  for (const row of completedRows) {
    const field = row.state === "cancelled" ? "cancelled" : row.state === "terminal_failure" ? "terminalFailures"
      : row.work_kind === "stenographer.output_repair" ? "outputRepairCompleted"
      : EXECUTION_KINDS.some(kind => kind === row.work_kind) ? "protectedCompleted" : null;
    if (field !== null) queue.last24h[field] = (BigInt(queue.last24h[field]) + BigInt(exactCount(row.count))).toString();
  }
  const agentMember = product.select({id: actors.id}).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(eq(roomMembers.roomId, rooms.id), eq(actors.kind, "agent")));
  const eligible = and(notInArray(rooms.kind, ["task", "access"]), isNull(roomJournalState.suspendedAt), exists(agentMember));
  const newerMessage = product.select({id: sessionMessages.id}).from(sessions)
    .innerJoin(sessionMessages, eq(sessionMessages.sessionId, sessions.id))
    .where(and(eq(sessions.roomId, rooms.id), sql`${sessionMessages.id} > ${roomJournalState.lastProcessedMessageId}`));
  const extractionWait = and(isNotNull(roomJournalState.extractionAuthorizationWaitingSince), or(
    and(eq(roomJournalState.extractionAuthorizationWaitLane, "live"), isNull(roomJournalState.rebuildRequestedAt), exists(newerMessage)),
    and(eq(roomJournalState.extractionAuthorizationWaitLane, "historical"), eq(roomJournalState.historicalBackfillStatus, "pending"), isNull(roomJournalState.rebuildRequestedAt)),
    and(eq(roomJournalState.extractionAuthorizationWaitLane, "rebuild"), isNotNull(roomJournalState.rebuildRequestedAt)),
  ));
  const compactionWait = and(isNotNull(roomJournalState.compactionAuthorizationWaitingSince),
    isNotNull(roomJournalState.compactionDueAt), isNull(roomJournalState.rebuildRequestedAt));
  const [waiting] = await product.select({
    extraction: sql<string>`COUNT(*) FILTER (WHERE ${extractionWait})::text`,
    compaction: sql<string>`COUNT(*) FILTER (WHERE ${compactionWait})::text`,
    extractionOldest: sql<string | null>`MIN(${roomJournalState.extractionAuthorizationWaitingSince}) FILTER (WHERE ${extractionWait})::text`,
    compactionOldest: sql<string | null>`MIN(${roomJournalState.compactionAuthorizationWaitingSince}) FILTER (WHERE ${compactionWait})::text`,
  }).from(roomJournalState).innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
    .where(and(eligible, sql`${policy.mode !== "plaintext_only"}`));
  if (waiting === undefined) throw new Error("Stenographer authority wait aggregate is absent");
  const nativeProtectedHead = product.select({id: reflectionRecordPayloadRepresentationHeads.recordId})
    .from(reflectionRecordPayloadRepresentationHeads).where(and(
      eq(reflectionRecordPayloadRepresentationHeads.recordId, roomEvents.recordId),
      eq(reflectionRecordPayloadRepresentationHeads.representation, "protected")));
  const unprotectedEvent = product.select({id: roomEvents.id}).from(roomEvents).where(and(
    eq(roomEvents.sourceBatchId, roomJournalBatches.id), eq(roomEvents.roomId, roomJournalBatches.roomId),
    eq(roomEvents.projectionKind, "native"), notExists(nativeProtectedHead)));
  const [missingBatches] = await product.select({count: COUNT,
    oldestAt: sql<string | null>`MIN(${roomJournalBatches.completedAt})::text`,
  }).from(roomJournalBatches).innerJoin(roomJournalState, eq(roomJournalState.roomId, roomJournalBatches.roomId))
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId)).where(and(eligible,
      eq(roomJournalBatches.status, "completed"), eq(roomJournalBatches.observationPublicationVersion, 2),
      isNotNull(roomJournalBatches.ordinaryFallbackReason),
      eq(roomJournalBatches.ordinaryFallbackRebuildGeneration, roomJournalState.rebuildGeneration),
      isNull(roomJournalState.rebuildRequestedAt), exists(unprotectedEvent)));
  const [missingRollups] = await product.select({count: COUNT,
    oldestAt: sql<string | null>`MIN(${roomEventRollups.createdAt})::text`,
  }).from(roomEventRollups).innerJoin(roomJournalState, eq(roomJournalState.roomId, roomEventRollups.roomId))
    .innerJoin(rooms, eq(rooms.id, roomJournalState.roomId)).where(and(eligible,
      isNotNull(roomEventRollups.ordinaryFallbackReason), isNull(roomEventRollups.cryptoObjectId),
      eq(roomEventRollups.ordinaryFallbackRebuildGeneration, roomJournalState.rebuildGeneration), isNull(roomJournalState.rebuildRequestedAt)));
  if (missingBatches === undefined || missingRollups === undefined) throw new Error("Stenographer fallback aggregate is absent");
  const extractionHistory = await product.select({reason: roomJournalBatches.ordinaryFallbackReason, count: COUNT})
    .from(roomJournalBatches).where(and(isNotNull(roomJournalBatches.ordinaryFallbackReason),
      gte(roomJournalBatches.completedAt, since), lte(roomJournalBatches.completedAt, until)))
    .groupBy(roomJournalBatches.ordinaryFallbackReason);
  const compactionHistory = await product.select({reason: roomEventRollups.ordinaryFallbackReason, count: COUNT})
    .from(roomEventRollups).where(and(isNotNull(roomEventRollups.ordinaryFallbackReason),
      gte(roomEventRollups.createdAt, since), lte(roomEventRollups.createdAt, until)))
    .groupBy(roomEventRollups.ordinaryFallbackReason);
  const history = (rows: typeof extractionHistory) => {
    const result = {device: "0", authority: "0"};
    for (const row of rows) {
      if (row.reason !== "device" && row.reason !== "authority") throw new TypeError("Invalid Stenographer fallback reason");
      result[row.reason] = exactCount(row.count);
    }
    return result;
  };
  return {dtoVersion: 1, generatedAt: now.toISOString(), window: {since: since.toISOString(), until: until.toISOString()}, queue,
    authorityWait: {extractionRooms: exactCount(waiting.extraction), compactionRooms: exactCount(waiting.compaction),
      oldestAt: oldest([timestamp(waiting.extractionOldest), timestamp(waiting.compactionOldest)])},
    plaintextFallback: {missingProtection: {extractionBatches: exactCount(missingBatches.count), compactionRollups: exactCount(missingRollups.count),
      oldestAt: oldest([timestamp(missingBatches.oldestAt), timestamp(missingRollups.oldestAt)])},
    last24h: {extraction: history(extractionHistory), compaction: history(compactionHistory)}},
  };
}
