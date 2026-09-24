import {
  acquireEncryptionPublicationFence,
  acquireOrdinaryEncryptionPublicationFence,
  ROOM_JOURNAL_EXTRACTOR_VERSION,
  acquireRoomWriteLock,
  alias,
  and,
  count,
  eq,
  inArray,
  max,
  pushMessageCandidates,
  roomJournalState,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { MessageDeleteError } from "./membership";
import {
  persistNotificationClassification,
  type AppendNotificationContext,
} from "./notification-classification";

export type CanonicalTranscriptTx = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

export interface CanonicalTranscriptAppendRow {
  role: string;
  /** Null is an absent ordinary representation, never an empty Message. */
  content: string | null;
  toolCalls: string | null;
  toolName: string | null;
  fingerprint: string | null;
  humanTurnId: string | null;
  transcriptOrigin: "main" | "subagent";
  parentThreadId: string | null;
  scopeId: string | null;
  metadata: Record<string, unknown> | null;
  subthreadRoomId: string | null;
  replyToMessageId: number | null;
  /**
   * Clear, bounded facts for protected rows. Legacy plaintext callers omit
   * this and retain their historical content/metadata-derived behavior.
   */
  protectedStructuralProjection?: CanonicalProtectedMessageStructuralProjection
    | undefined;
}

export interface CanonicalProtectedMessageStructuralProjection {
  readonly notificationEligibility: "eligible" | "excluded";
  readonly subthreadReplyClassification: "counted" | "excluded";
  /**
   * A protected live operation may reserve the canonical serial coordinate
   * before client-side encryption. Only the existing-Session protected append
   * entrypoint accepts this value; ordinary and Session-creating appends must
   * continue allocating their own IDs.
   */
  readonly reservedMessageId?: number | undefined;
  readonly reservedCreatedAt?: Date | undefined;
}

export interface CanonicalTranscriptSessionInput {
  threadId: string;
  ownerId: string;
  personaId: string;
  agentId?: string | undefined;
  roomId?: string | undefined;
  title: string;
}

export interface CanonicalTranscriptAppendInput {
  session: CanonicalTranscriptSessionInput;
  rows: readonly CanonicalTranscriptAppendRow[];
  notificationContext?: AppendNotificationContext | undefined;
  publicationPolicy?: CanonicalTranscriptPublicationPolicy | undefined;
}

export interface CanonicalExistingSessionAppendInput {
  sessionId: string;
  rows: readonly CanonicalTranscriptAppendRow[];
  notificationContext?: AppendNotificationContext | undefined;
  publicationPolicy?: CanonicalTranscriptPublicationPolicy | undefined;
}

type CanonicalTranscriptPublicationPolicy = Readonly<{
  expectedRevision: number;
  representation: "ordinary_and_protected" | "protected_only";
}>;

async function fenceTranscriptPublication(
  tx: CanonicalTranscriptTx,
  rows: readonly CanonicalTranscriptAppendRow[],
  policy: CanonicalTranscriptPublicationPolicy | undefined,
): Promise<void> {
  if (policy?.representation === "protected_only") {
    if (rows.some((row) => row.content !== null)) {
      throw new TypeError("Protected-only transcript publication contains ordinary content");
    }
  } else if (rows.some((row) => row.content === null)) {
    throw new TypeError("Protected-only transcript requires an exact publication policy");
  }
  if (policy === undefined) await acquireOrdinaryEncryptionPublicationFence(tx);
  else await acquireEncryptionPublicationFence(tx, policy);
}

export interface CanonicalTranscriptAllocatedRowContext {
  tx: CanonicalTranscriptTx;
  sessionId: string;
  roomId: string | null;
  rowIndex: number;
  messageId: number;
  row: CanonicalTranscriptAppendRow;
}

export interface CanonicalTranscriptAppendHooks<T = void> {
  /**
   * Invoked only for a genuinely new row, after its stable serial ID has
   * explicitly been allocated and immediately before the message INSERT.
   *
   * Protected callers must resolve their durable operation-id replay before
   * calling this primitive. The primitive independently checks the canonical
   * `(session_id, fingerprint)` dedup key before allocating an ID.
   */
  afterMessageIdAllocated?(
    context: CanonicalTranscriptAllocatedRowContext,
  ): Promise<T>;
}

export interface CanonicalTranscriptInsertedRow<T = void> {
  createdAt?: string;
  id: string;
  role: string;
  content: string | null;
  fingerprint: string | null;
  replyToMessageId: number | null;
  hookResult?: T | undefined;
}

export interface CanonicalTranscriptAppendResult<T = void> {
  failedIndices: number[];
  insertedCount: number;
  insertedRows: CanonicalTranscriptInsertedRow<T>[];
  rootSummary?: CanonicalRootSummary | undefined;
}

export interface CanonicalRootSummary {
  parentRoomId: string;
  anchorMessageId: number;
  replyCount: number;
  lastReplyAt: Date | null;
  revision: number;
}

export interface CanonicalHardDeleteEffects {
  roomId: string;
  wasUnread: boolean;
  orphanedTurnId: string | null;
  rootSummary: CanonicalRootSummary | null;
}

export interface CanonicalHardDeleteHookContext {
  tx: CanonicalTranscriptTx;
  messageId: number;
  sessionId: string;
  editRevision: number;
  effects: CanonicalHardDeleteEffects;
}

export interface CanonicalHardDeleteHooks<T = void> {
  /** Trusted ban cleanup may retain the child Room's structural anchor while
   * deleting the original message and all canonical cascades. */
  preserveThreadOnModerationDelete?: boolean;
  /**
   * Runs after every canonical delete side effect is known and before commit.
   * A protected caller uses this to persist the durable terminal receipt.
   */
  afterDeleteEffects?(context: CanonicalHardDeleteHookContext): Promise<T>;
}

export type CanonicalHardDeleteResult<T = void> =
  CanonicalHardDeleteEffects & {
    hookResult?: T | undefined;
  };

export interface CanonicalTranscriptEditRow {
  messageId: number;
  sessionId: string;
  role: string;
  editRevision: number;
}

export interface CanonicalTranscriptEditHookContext {
  tx: CanonicalTranscriptTx;
  roomId: string;
  requestedMessageId: number;
  rows: readonly CanonicalTranscriptEditRow[];
  nextRevision: number;
  editedAt: Date;
}

export interface CanonicalTranscriptEditHooks<T = void> {
  /** Runs after canonical Room/Message locks and exact fanout validation, before writes. */
  beforeRowsEdited?(context: CanonicalTranscriptEditHookContext): Promise<void>;
  /**
   * Runs after every physical copy and Room journal invalidation are staged,
   * but before commit. Protected callers persist one lifecycle per row here.
   */
  afterRowsEdited?(context: CanonicalTranscriptEditHookContext): Promise<T>;
}

export interface CanonicalTranscriptEditResult<T = void> {
  roomId: string;
  requestedMessageId: number;
  rows: readonly CanonicalTranscriptEditRow[];
  nextRevision: number;
  editedAt: Date;
  logicalMessageKey: string | null;
  hookResult?: T | undefined;
}

/** Reject secondary ordinary-body fields before allocating or publishing a row. */
function assertCanonicalTranscriptRepresentation(
  row: CanonicalTranscriptAppendRow,
): void {
  if (row.content !== null) {
    if (typeof row.content !== "string") {
      throw new TypeError("Canonical transcript content must be text or absent");
    }
    return;
  }
  if (row.protectedStructuralProjection === undefined) {
    throw new TypeError("Absent ordinary content requires a protected structural projection");
  }
  if (row.toolCalls !== null || row.toolName !== null || row.metadata !== null) {
    throw new TypeError("Protected-only transcript cannot retain ordinary tool or metadata bodies");
  }
}

function isPostgresUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    depth < 10
    && current !== undefined
    && current !== null
    && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (code === "23505" || code === 23505) return true;
    }
    let message = "";
    if (current instanceof Error) {
      message = current.message;
    } else if (
      typeof current === "object"
      && current !== null
      && "message" in current
      && typeof (current as { message: unknown }).message === "string"
    ) {
      message = (current as { message: string }).message;
    }
    if (/duplicate key|unique constraint|uq_sessions_owner_thread/i.test(message)) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : undefined;
  }
  return false;
}

async function ensureSessionInTx(
  tx: CanonicalTranscriptTx,
  input: CanonicalTranscriptSessionInput,
): Promise<string> {
  const existing = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.threadId, input.threadId),
        eq(sessions.ownerId, input.ownerId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  try {
    const inserted = await tx
      .insert(sessions)
      .values({
        threadId: input.threadId,
        ownerId: input.ownerId,
        personaId: input.personaId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.roomId ? { roomId: input.roomId } : {}),
        title: input.title,
      })
      .onConflictDoNothing({ target: [sessions.ownerId, sessions.threadId] })
      .returning({ id: sessions.id });
    if (inserted[0]) return inserted[0].id;
  } catch (error) {
    if (!isPostgresUniqueViolation(error)) throw error;
  }

  const resolved = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.threadId, input.threadId),
        eq(sessions.ownerId, input.ownerId),
      ),
    )
    .limit(1);
  if (!resolved[0]) {
    throw new Error("Failed to create or resolve session after conflict");
  }
  return resolved[0].id;
}

/**
 * The single pure predicate for denormalized Subthread root summaries.
 */
export function isCountedReplyRow(row: {
  role: string;
  content: string;
  originatedBy?: string | null | undefined;
}): boolean {
  if (row.role !== "user" && row.role !== "assistant") return false;
  if (row.role === "assistant" && row.content === "") return false;
  return row.originatedBy !== "task" && row.originatedBy !== "connected_web_operation";
}

function countedChildReplyWhere(subthreadRoomId: string) {
  return and(
    eq(sessionMessages.subthreadRoomId, subthreadRoomId),
    sql`${sessionMessages.role} IN ('user','assistant')`,
    sql`(${sessionMessages.role} = 'user' OR ${sessionMessages.content} <> '')`,
    sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,
  );
}

async function recomputeLegacyRootSummary(
  tx: CanonicalTranscriptTx,
  rootMessageId: number,
  subthreadRoomId: string,
): Promise<Omit<CanonicalRootSummary, "parentRoomId" | "anchorMessageId">> {
  const [aggregate] = await tx
    .select({
      replyCount: count(),
      lastReplyAt: max(sessionMessages.createdAt),
    })
    .from(sessionMessages)
    .where(countedChildReplyWhere(subthreadRoomId));

  const replyCount = Number(aggregate?.replyCount ?? 0);
  const lastReplyAt = (aggregate?.lastReplyAt as Date | null) ?? null;
  const [updated] = await tx
    .update(sessionMessages)
    .set({
      replyCount,
      lastReplyAt,
      summaryRevision: sql`${sessionMessages.summaryRevision} + 1`,
    })
    .where(eq(sessionMessages.id, rootMessageId))
    .returning({ revision: sessionMessages.summaryRevision });
  return {
    replyCount,
    lastReplyAt,
    revision: updated?.revision ?? await updateDeletedThreadSummary(tx, subthreadRoomId, replyCount, lastReplyAt),
  };
}

async function updateDeletedThreadSummary(tx: CanonicalTranscriptTx, roomId: string, replyCount: number, lastReplyAt: Date | null): Promise<number> {
  const [updated] = await tx.update(rooms).set({ deletedThreadReplyCount: replyCount, deletedThreadLastReplyAt: lastReplyAt,
    deletedThreadSummaryRevision: sql`${rooms.deletedThreadSummaryRevision} + 1`,
  }).where(and(eq(rooms.id, roomId), sql`${rooms.deletedThreadRootMessageId} IS NOT NULL`))
    .returning({ revision: rooms.deletedThreadSummaryRevision });
  return updated?.revision ?? 0;
}

async function recomputeProtectedRootSummary(
  tx: CanonicalTranscriptTx,
  rootMessageId: number,
  subthreadRoomId: string,
): Promise<Omit<CanonicalRootSummary, "parentRoomId" | "anchorMessageId">> {
  const [protectedAggregate] = await tx.select({
    reply_count: sql<number>`count(*)::integer`.as("reply_count"),
    last_reply_at: max(sessionMessages.createdAt),
  })
    .from(sessionMessages)
    .innerJoin(
      sessionMessageCryptoRevisions,
      and(
        eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
        eq(
          sessionMessageCryptoRevisions.editRevision,
          sessionMessages.editRevision,
        ),
      ),
    )
    .where(and(
      eq(sessionMessages.subthreadRoomId, subthreadRoomId),
      eq(
        sessionMessageCryptoRevisions.subthreadReplyClassification,
        "counted",
      ),
    ));
  const [legacyAggregate] = await tx.execute<{
    reply_count: number | bigint;
    last_reply_at: Date | string | null;
  }>(sql`
    SELECT count(*)::integer AS reply_count,
           max(legacy_message.created_at) AS last_reply_at
      FROM session_messages AS legacy_message
     WHERE legacy_message.subthread_room_id = ${subthreadRoomId}::uuid
       AND NOT EXISTS (
         SELECT 1
           FROM session_message_crypto_revisions AS protected_lifecycle
          WHERE protected_lifecycle.message_id = legacy_message.id
            AND protected_lifecycle.edit_revision =
                  legacy_message.edit_revision
       )
       AND legacy_message.role IN ('user','assistant')
       AND (
         legacy_message.role = 'user'
         OR legacy_message.content <> ''
       )
       AND (
         legacy_message.metadata->>'originatedBy'
       ) IS DISTINCT FROM 'task'
       AND (legacy_message.metadata->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'
  `);
  const protectedCount = Number(protectedAggregate?.reply_count ?? 0);
  const legacyCount = Number(legacyAggregate?.reply_count ?? 0);
  const protectedLast = protectedAggregate?.last_reply_at ?? null;
  // Raw aggregate rows bypass Drizzle's timestamp decoder.
  const legacyLastValue = legacyAggregate?.last_reply_at ?? null;
  const legacyLast = typeof legacyLastValue === "string" ? new Date(legacyLastValue) : legacyLastValue;
  const lastReplyAt =
    protectedLast === null
      ? legacyLast
      : legacyLast === null
      ? protectedLast
      : protectedLast > legacyLast
      ? protectedLast
      : legacyLast;
  const [updated] = await tx
    .update(sessionMessages)
    .set({
      replyCount: protectedCount + legacyCount,
      lastReplyAt,
      summaryRevision: sql`${sessionMessages.summaryRevision} + 1`,
    })
    .where(eq(sessionMessages.id, rootMessageId))
    .returning({ revision: sessionMessages.summaryRevision });
  return {
    replyCount: protectedCount + legacyCount,
    lastReplyAt,
    revision: updated?.revision ?? await updateDeletedThreadSummary(tx, subthreadRoomId, protectedCount + legacyCount, lastReplyAt),
  };
}

async function resolveSubthreadRoot(
  tx: CanonicalTranscriptTx,
  subthreadRoomId: string,
): Promise<
  Pick<CanonicalRootSummary, "parentRoomId" | "anchorMessageId"> | null
> {
  const [row] = await tx
    .select({
      parentRoomId: rooms.parentRoomId,
      anchorMessageId: sql<number | null>`COALESCE(${rooms.threadRootMessageId}, ${rooms.deletedThreadRootMessageId})`,
    })
    .from(rooms)
    .where(and(eq(rooms.id, subthreadRoomId), eq(rooms.kind, "subthread")))
    .limit(1);
  if (!row?.parentRoomId || row.anchorMessageId === null) return null;
  return {
    parentRoomId: row.parentRoomId,
    anchorMessageId: row.anchorMessageId,
  };
}

async function resolveSessionRoomId(
  tx: CanonicalTranscriptTx,
  sessionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ roomId: sessions.roomId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.roomId ?? null;
}

async function validateProtectedAppendAnchorsInTx(
  tx: CanonicalTranscriptTx,
  roomId: string,
  rows: readonly CanonicalTranscriptAppendRow[],
): Promise<void> {
  for (const row of rows) {
    if (row.subthreadRoomId !== null) {
      if (row.subthreadRoomId !== roomId) {
        throw new Error(
          "Protected append Subthread does not belong to its Session Room",
        );
      }
      const childRoom = alias(rooms, "child_room");
      const parentRoom = alias(rooms, "parent_room");
      const subthread = await tx.select({ valid: sql<boolean>`true` })
        .from(childRoom)
        .innerJoin(parentRoom, eq(parentRoom.id, childRoom.parentRoomId))
        .where(and(
          eq(childRoom.id, roomId),
          eq(childRoom.kind, "subthread"),
          eq(childRoom.namespaceId, parentRoom.namespaceId),
        ))
        .limit(1);
      if (subthread.length === 0) {
        throw new Error(
          "Protected append Subthread is outside its stable Room Namespace",
        );
      }
    }
    if (row.replyToMessageId !== null) {
      const replyTargetMessage = alias(sessionMessages, "reply_target");
      const targetSession = alias(sessions, "target_session");
      const targetRoom = alias(rooms, "target_room");
      const currentRoom = alias(rooms, "current_room");
      const replyTarget = await tx.select({ valid: sql<boolean>`true` })
        .from(replyTargetMessage)
        .innerJoin(
          targetSession,
          eq(targetSession.id, replyTargetMessage.sessionId),
        )
        .innerJoin(targetRoom, eq(targetRoom.id, targetSession.roomId))
        .innerJoin(currentRoom, eq(currentRoom.id, roomId))
        .where(and(
          eq(replyTargetMessage.id, row.replyToMessageId),
          eq(targetSession.roomId, roomId),
          eq(targetRoom.namespaceId, currentRoom.namespaceId),
        ))
        .limit(1);
      if (replyTarget.length === 0) {
        throw new Error(
          "Protected append reply target is outside its stable Room Namespace",
        );
      }
    }
  }
}

async function fingerprintAlreadyExists(
  tx: CanonicalTranscriptTx,
  sessionId: string,
  fingerprint: string | null,
): Promise<boolean> {
  if (fingerprint === null) return false;
  const [existing] = await tx
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(
      and(
        eq(sessionMessages.sessionId, sessionId),
        eq(sessionMessages.fingerprint, fingerprint),
      ),
    )
    .limit(1);
  return existing !== undefined;
}

async function allocateMessageId(tx: CanonicalTranscriptTx): Promise<number> {
  const result = await tx.execute<{ id: number }>(sql`
    SELECT nextval(
      pg_get_serial_sequence('session_messages', 'id')
    )::integer AS id
  `);
  const [allocated] = result;
  if (!allocated || !Number.isInteger(allocated.id) || allocated.id <= 0) {
    throw new Error("Failed to allocate canonical transcript message ID");
  }
  return allocated.id;
}

/**
 * Reserve one canonical serial coordinate for a product-owned protected
 * lifecycle before any content-bearing realtime frame is emitted.
 * The caller must hold the owning Room lock in the same transaction.
 */
export async function reserveCanonicalTranscriptMessageIdInTx(
  tx: CanonicalTranscriptTx,
): Promise<number> {
  return allocateMessageId(tx);
}

/**
 * Canonical transaction-scoped append. Both legacy plaintext append and the
 * protected shadow-saga append delegate here, so they cannot drift on Room
 * locking, Session creation, message shape, classification or summaries.
 */
export async function appendCanonicalTranscriptRowsInTx<T = void>(
  tx: CanonicalTranscriptTx,
  input: CanonicalTranscriptAppendInput,
  hooks: CanonicalTranscriptAppendHooks<T> = {},
): Promise<CanonicalTranscriptAppendResult<T>> {
  if (input.rows.length === 0) {
    return { failedIndices: [], insertedCount: 0, insertedRows: [] };
  }
  input.rows.forEach(assertCanonicalTranscriptRepresentation);
  if (
    input.rows.some(
      (row) =>
        row.protectedStructuralProjection?.reservedMessageId !== undefined,
    )
  ) {
    throw new TypeError(
      "Reserved protected message IDs require an existing Session",
    );
  }

  await fenceTranscriptPublication(tx, input.rows, input.publicationPolicy);
  if (input.session.roomId) {
    await acquireRoomWriteLock(tx, input.session.roomId);
  }
  const sessionId = await ensureSessionInTx(tx, input.session);
  const roomId =
    input.session.roomId ?? await resolveSessionRoomId(tx, sessionId);
  if (!input.session.roomId && roomId) {
    await acquireRoomWriteLock(tx, roomId);
  }

  return appendRowsForResolvedSessionInTx(
    tx,
    sessionId,
    roomId,
    input.rows,
    input.notificationContext,
    hooks,
  );
}

/**
 * Protected-path companion for a caller that already owns the canonical
 * Session coordinate. It resolves the Session's authoritative Room and takes
 * that Room lock before fingerprint dedup or message-ID allocation.
 */
export async function appendCanonicalTranscriptRowsToExistingSessionInTx<
  T = void,
>(
  tx: CanonicalTranscriptTx,
  input: CanonicalExistingSessionAppendInput,
  hooks: CanonicalTranscriptAppendHooks<T> = {},
): Promise<CanonicalTranscriptAppendResult<T>> {
  if (input.rows.length === 0) {
    return { failedIndices: [], insertedCount: 0, insertedRows: [] };
  }
  input.rows.forEach(assertCanonicalTranscriptRepresentation);
  await fenceTranscriptPublication(tx, input.rows, input.publicationPolicy);
  const roomId = await resolveSessionRoomId(tx, input.sessionId);
  if (!roomId) {
    throw new Error(
      "Canonical protected append requires an existing Room-bound Session",
    );
  }
  await acquireRoomWriteLock(tx, roomId);
  const protectedRows = input.rows.filter(
    (row) => row.protectedStructuralProjection !== undefined,
  );
  if (protectedRows.length > 0) {
    await validateProtectedAppendAnchorsInTx(tx, roomId, protectedRows);
  }
  return appendRowsForResolvedSessionInTx(
    tx,
    input.sessionId,
    roomId,
    input.rows,
    input.notificationContext,
    hooks,
  );
}

/**
 * Canonical transaction-scoped edit mechanics shared by protected message
 * writers. A Human row is a logical turn: every same-owner, same-Room
 * fingerprint copy changes together. Non-Human roles are deliberately
 * single-row operations. The Room lock precedes every physical row lock.
 */
export async function editCanonicalTranscriptMessageInTx<T = void>(
  tx: CanonicalTranscriptTx,
  input: {
    messageId: number;
    expectedRevision: number;
    content: string;
    clearCryptoObjectId: boolean;
    editedAt?: Date;
    protectedTargets?: never;
    publicationPolicy?: never;
  } | {
    messageId: number;
    expectedRevision: number;
    content: null;
    clearCryptoObjectId?: never;
    editedAt?: Date;
    protectedTargets: readonly Readonly<{
      sessionId: string;
      messageId: number;
      cryptoObjectId: string;
    }>[];
    publicationPolicy: Readonly<{
      expectedRevision: number;
      representation: "protected_only";
    }>;
  },
  hooks: CanonicalTranscriptEditHooks<T> = {},
): Promise<CanonicalTranscriptEditResult<T> | null> {
  if (input.content === null) {
    await acquireEncryptionPublicationFence(tx, input.publicationPolicy);
  } else {
    await acquireOrdinaryEncryptionPublicationFence(tx);
  }
  const [coordinate] = await tx
    .select({ roomId: sessions.roomId })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, input.messageId))
    .limit(1);
  if (!coordinate?.roomId) return null;

  await acquireRoomWriteLock(tx, coordinate.roomId);
  const [target] = await tx
    .select({
      messageId: sessionMessages.id,
      sessionId: sessionMessages.sessionId,
      role: sessionMessages.role,
      fingerprint: sessionMessages.fingerprint,
      editRevision: sessionMessages.editRevision,
      ownerId: sessions.ownerId,
      roomId: sessions.roomId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(
      and(
        eq(sessionMessages.id, input.messageId),
        eq(sessions.roomId, coordinate.roomId),
      ),
    )
    .for("update", { of: sessionMessages })
    .limit(1);
  if (!target?.roomId) return null;

  const physicalRows =
    target.role === "user" && target.fingerprint !== null
      ? await tx
        .select({
          messageId: sessionMessages.id,
          sessionId: sessionMessages.sessionId,
          role: sessionMessages.role,
          editRevision: sessionMessages.editRevision,
        })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
        .where(
          and(
            eq(sessions.roomId, target.roomId),
            eq(sessions.ownerId, target.ownerId),
            eq(sessionMessages.role, "user"),
            eq(sessionMessages.fingerprint, target.fingerprint),
          ),
        )
        .for("update", { of: sessionMessages })
      : [{
        messageId: target.messageId,
        sessionId: target.sessionId,
        role: target.role,
        editRevision: target.editRevision,
      }];
  const rows = physicalRows
    .map((row) => ({ ...row }))
    .sort((left, right) => left.messageId - right.messageId);
  if (
    rows.length === 0
    || rows.some((row) => row.editRevision !== input.expectedRevision)
  ) return null;

  const protectedObjectByCoordinate = input.content === null
    ? new Map(input.protectedTargets.map((target) => [
      `${target.sessionId}:${target.messageId}`,
      target.cryptoObjectId,
    ]))
    : null;
  if (
    protectedObjectByCoordinate !== null
    && (
      protectedObjectByCoordinate.size !== rows.length
      || rows.some((row) => !protectedObjectByCoordinate.has(
        `${row.sessionId}:${row.messageId}`,
      ))
    )
  ) return null;

  const editedAt = input.editedAt ?? new Date();
  const nextRevision = input.expectedRevision + 1;
  await hooks.beforeRowsEdited?.({
    tx,
    roomId: target.roomId,
    requestedMessageId: input.messageId,
    rows,
    nextRevision,
    editedAt,
  });
  const protectedUpdates: Array<{ messageId: number }> = [];
  if (input.content === null) {
    for (const row of rows) {
      protectedUpdates.push(...await tx.update(sessionMessages).set({
          content: null,
          toolCalls: null,
          toolName: null,
          cryptoObjectId: protectedObjectByCoordinate!.get(
            `${row.sessionId}:${row.messageId}`,
          )!,
          editRevision: nextRevision,
          editedAt,
        }).where(and(
          eq(sessionMessages.id, row.messageId),
          eq(sessionMessages.sessionId, row.sessionId),
          eq(sessionMessages.editRevision, input.expectedRevision),
        )).returning({ messageId: sessionMessages.id }));
    }
  }
  const updated = input.content === null
    ? protectedUpdates
    : await tx
      .update(sessionMessages)
      .set({
        content: input.content,
        editRevision: nextRevision,
        editedAt,
        ...(input.clearCryptoObjectId ? { cryptoObjectId: null } : {}),
      })
      .where(
        and(
          inArray(
            sessionMessages.id,
            rows.map((row) => row.messageId),
          ),
          eq(sessionMessages.editRevision, input.expectedRevision),
        ),
      )
      .returning({ messageId: sessionMessages.id });
  if (updated.length !== rows.length) {
    throw new Error(
      "Canonical logical edit lost a locked physical row during update",
    );
  }

  await tx
    .insert(roomJournalState)
    .values({
      roomId: target.roomId,
      lastProcessedMessageId: 0,
      extractorVersion: ROOM_JOURNAL_EXTRACTOR_VERSION,
      rebuildGeneration: 1,
      rebuildRequestedAt: editedAt,
      rebuildTargetMessageId: null,
      createdAt: editedAt,
      updatedAt: editedAt,
    })
    .onConflictDoUpdate({
      target: roomJournalState.roomId,
      set: {
        rebuildGeneration: sql`${roomJournalState.rebuildGeneration} + 1`,
        rebuildRequestedAt: editedAt,
        rebuildTargetMessageId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        compactionLeaseToken: null,
        compactionLeaseExpiresAt: null,
        updatedAt: editedAt,
      },
    });

  const hookResult = await hooks.afterRowsEdited?.({
    tx,
    roomId: target.roomId,
    requestedMessageId: input.messageId,
    rows,
    nextRevision,
    editedAt,
  });
  return {
    roomId: target.roomId,
    requestedMessageId: input.messageId,
    rows,
    nextRevision,
    editedAt,
    logicalMessageKey: target.fingerprint,
    ...(hooks.afterRowsEdited ? { hookResult } : {}),
  };
}

async function appendRowsForResolvedSessionInTx<T>(
  tx: CanonicalTranscriptTx,
  sessionId: string,
  roomId: string | null,
  rows: readonly CanonicalTranscriptAppendRow[],
  notificationContext: AppendNotificationContext | undefined,
  hooks: CanonicalTranscriptAppendHooks<T>,
): Promise<CanonicalTranscriptAppendResult<T>> {
  const failedIndices: number[] = [];
  const insertedRows: CanonicalTranscriptInsertedRow<T>[] = [];
  let insertedCountedReply = false;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    if (await fingerprintAlreadyExists(tx, sessionId, row.fingerprint)) {
      continue;
    }

    const reservedMessageId =
      row.protectedStructuralProjection?.reservedMessageId;
    const reservedCreatedAt =
      row.protectedStructuralProjection?.reservedCreatedAt;
    if (
      reservedMessageId !== undefined
      && (!Number.isSafeInteger(reservedMessageId) || reservedMessageId < 1)
    ) {
      throw new TypeError("Reserved protected message ID must be positive");
    }
    if (
      reservedCreatedAt !== undefined
      && !Number.isFinite(reservedCreatedAt.getTime())
    ) throw new TypeError("Reserved protected message timestamp is invalid");
    if ((reservedMessageId === undefined) !== (reservedCreatedAt === undefined)) {
      throw new TypeError(
        "Reserved protected message ID and timestamp must travel together",
      );
    }
    const messageId = reservedMessageId ?? await allocateMessageId(tx);
    let insertedMessageId: number | null = null;
    let insertedCreatedAt: string | undefined;
    let hookResult: T | undefined;
    try {
      hookResult = await hooks.afterMessageIdAllocated?.({
        tx,
        sessionId,
        roomId,
        rowIndex,
        messageId,
        row,
      });
      const {
        protectedStructuralProjection: _protectedStructuralProjection,
        ...persistedRow
      } = row;
      const inserted = await tx
        .insert(sessionMessages)
        .values({
          id: messageId,
          sessionId,
          ...persistedRow,
          ...(reservedCreatedAt === undefined
            ? {}
            : { createdAt: new Date(reservedCreatedAt.getTime()) }),
        })
        .onConflictDoNothing({
          target: [sessionMessages.sessionId, sessionMessages.fingerprint],
          where: sql`${sessionMessages.fingerprint} IS NOT NULL`,
        })
        .returning({ id: sessionMessages.id, createdAt: sessionMessages.createdAt });

      if (!inserted[0]) {
        if (hooks.afterMessageIdAllocated) {
          throw new Error(
            "Canonical protected append lost a fingerprint race after allocation",
          );
        }
        continue;
      }
      insertedMessageId = inserted[0].id;
      insertedCreatedAt = inserted[0].createdAt?.toISOString();
    } catch (error) {
      if (hooks.afterMessageIdAllocated) throw error;
      const message = error instanceof Error ? error.message : String(error);
      warn(
        `[nautilo/store] session_messages row insert failed (idx=${rowIndex} role=${row.role} fpLen=${row.fingerprint?.length ?? 0}): ${message}`,
      );
      failedIndices.push(rowIndex);
      continue;
    }

    insertedRows.push({
      id: String(insertedMessageId),
      ...(insertedCreatedAt ? { createdAt: insertedCreatedAt } : {}),
      role: row.role,
      content: row.content,
      fingerprint: row.fingerprint,
      replyToMessageId: row.replyToMessageId,
      ...(hooks.afterMessageIdAllocated ? { hookResult } : {}),
    });
    insertedCountedReply ||= row.protectedStructuralProjection === undefined
      ? isCountedReplyRow({
        role: row.role,
        // The representation check above rejects absent content without the
        // structural projection; keep this branch honest even for JS callers.
        content: requireOrdinaryTranscriptContent(row.content),
        originatedBy:
          typeof row.metadata?.["originatedBy"] === "string"
            ? row.metadata["originatedBy"]
            : null,
      })
      : row.protectedStructuralProjection.subthreadReplyClassification
        === "counted";

    // Classification failures deliberately abort the entire transaction. A
    // transcript row must never commit without its required M233 facts.
    if (
      row.protectedStructuralProjection !== undefined
      && row.role !== "user"
      && row.role !== "assistant"
      && row.role !== "tool"
      && row.role !== "system"
    ) {
      throw new Error("Protected append role is outside the closed projection");
    }
    const notificationEligible = await persistNotificationClassification(tx, {
      messageId: insertedMessageId,
      context: notificationContext ?? {
        mentionedHumanUserIds: [],
        causalHumanUserId: null,
        causalHumanTurnId: null,
      },
      ...(row.protectedStructuralProjection === undefined
        ? {}
        : {
          protectedProjection: {
            role: row.role as "user" | "assistant" | "tool" | "system",
            transcriptOrigin: row.transcriptOrigin,
            replyToMessageId: row.replyToMessageId,
            eligibility:
              row.protectedStructuralProjection.notificationEligibility,
          },
        }),
    });
    if (notificationEligible) {
      // This write deliberately remains inside the canonical append
      // transaction. Post-commit event delivery may be lost on process death;
      // the content-free candidate cannot be.
      await tx
        .insert(pushMessageCandidates)
        .values({ messageId: insertedMessageId })
        .onConflictDoNothing();
    }
  }

  const insertedCount = insertedRows.length;
  if (insertedCount > 0) {
    const [current] = await tx
      .select({ messageCount: sessions.messageCount })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    await tx
      .update(sessions)
      .set({
        messageCount: (current?.messageCount ?? 0) + insertedCount,
        endedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
  }

  let rootSummary: CanonicalRootSummary | undefined;
  const subthreadRoomId = rows[0]?.subthreadRoomId ?? null;
  if (subthreadRoomId && insertedCountedReply) {
    const root = await resolveSubthreadRoot(tx, subthreadRoomId);
    if (root) {
      rootSummary = {
        ...root,
        ...(rows.some(
            (row) => row.protectedStructuralProjection !== undefined,
          )
          ? await recomputeProtectedRootSummary(
            tx,
            root.anchorMessageId,
            subthreadRoomId,
          )
          : await recomputeLegacyRootSummary(
            tx,
            root.anchorMessageId,
            subthreadRoomId,
          )),
      };
    }
  }

  if (failedIndices.length === rows.length) {
    throw new Error(
      `appendTranscriptMessages: every row failed (${failedIndices.length}/${rows.length})`,
    );
  }

  return { failedIndices, insertedCount, insertedRows, rootSummary };
}

function requireOrdinaryTranscriptContent(content: string | null): string {
  if (content === null) throw new Error("Ordinary transcript representation is unavailable");
  return content;
}

/**
 * Canonical transaction-scoped physical delete and every product-side effect.
 */
export async function deleteMessageHardInTx<T = void>(
  tx: CanonicalTranscriptTx,
  messageId: number,
  hooks: CanonicalHardDeleteHooks<T> & {
    readonly protectedStructuralProjection?:
      Pick<
        CanonicalProtectedMessageStructuralProjection,
        "subthreadReplyClassification"
      >;
  } = {},
): Promise<CanonicalHardDeleteResult<T>> {
  const [coordinate] = await tx
    .select({ roomId: sessions.roomId })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, messageId))
    .limit(1);
  if (!coordinate?.roomId) throw new MessageDeleteError("not_found");

  await acquireRoomWriteLock(tx, coordinate.roomId);
  const [anchor] = await tx
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.threadRootMessageId, messageId))
    .limit(1);
  if (anchor && hooks.preserveThreadOnModerationDelete) await acquireRoomWriteLock(tx, anchor.id);
  const [row] = await tx
    .select({
      roomId: sessions.roomId,
      sessionId: sessionMessages.sessionId,
      editRevision: sessionMessages.editRevision,
      readAt: sessionMessages.readAt,
      fingerprint: sessionMessages.fingerprint,
      role: sessionMessages.role,
      ...(hooks.protectedStructuralProjection === undefined
        ? {
          content: sessionMessages.content,
          metadata: sessionMessages.metadata,
        }
        : {}),
      subthreadRoomId: sessionMessages.subthreadRoomId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(
      and(
        eq(sessionMessages.id, messageId),
        eq(sessions.roomId, coordinate.roomId),
      ),
    )
    .for("update", { of: sessionMessages })
    .limit(1);
  if (!row?.roomId) throw new MessageDeleteError("not_found");

  if (anchor) {
    if (!hooks.preserveThreadOnModerationDelete) throw new MessageDeleteError("message_anchors_thread");
    await tx.update(rooms).set({ deletedThreadRootMessageId: messageId,
      deletedThreadReplyCount: sql`(SELECT reply_count FROM session_messages WHERE id = ${messageId})`,
      deletedThreadLastReplyAt: sql`(SELECT last_reply_at FROM session_messages WHERE id = ${messageId})`,
      deletedThreadSummaryRevision: sql`(SELECT summary_revision + 1 FROM session_messages WHERE id = ${messageId})`,
    }).where(eq(rooms.id, anchor.id));
  }

  await tx.delete(sessionMessages).where(eq(sessionMessages.id, messageId));
  await tx
    .update(sessions)
    .set({ messageCount: sql`GREATEST(0, ${sessions.messageCount} - 1)` })
    .where(eq(sessions.id, row.sessionId));

  let orphanedTurnId: string | null = null;
  if (row.fingerprint) {
    const [remaining] = await tx
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.fingerprint, row.fingerprint))
      .limit(1);
    if (!remaining) orphanedTurnId = row.fingerprint;
  }

  let rootSummary: CanonicalRootSummary | null = null;
  if (
    row.subthreadRoomId !== null
    && (
      hooks.protectedStructuralProjection === undefined
        ? isCountedReplyRow({
          role: row.role,
          content: "content" in row && typeof row.content === "string"
            ? row.content
            : "",
          originatedBy:
            "metadata" in row
              && typeof row.metadata === "object"
              && row.metadata !== null
              && typeof row.metadata["originatedBy"] === "string"
              ? row.metadata["originatedBy"]
              : null,
        })
        : hooks.protectedStructuralProjection
            .subthreadReplyClassification === "counted"
    )
  ) {
    const root = await resolveSubthreadRoot(tx, row.subthreadRoomId);
    if (root) {
      rootSummary = {
        ...root,
          ...(hooks.protectedStructuralProjection === undefined
            ? await recomputeLegacyRootSummary(
              tx,
              root.anchorMessageId,
              row.subthreadRoomId,
            )
            : await recomputeProtectedRootSummary(
              tx,
              root.anchorMessageId,
              row.subthreadRoomId,
            )),
      };
    }
  }

  const effects: CanonicalHardDeleteEffects = {
    roomId: row.roomId,
    wasUnread: row.readAt === null,
    orphanedTurnId,
    rootSummary,
  };
  const hookResult = await hooks.afterDeleteEffects?.({
    tx,
    messageId,
    sessionId: row.sessionId,
    editRevision: row.editRevision,
    effects,
  });
  return {
    ...effects,
    ...(hooks.afterDeleteEffects ? { hookResult } : {}),
  };
}
