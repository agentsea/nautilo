import {
  and, asc, eq, gt, lt, lte, or, sql, sessions, sessionMessages,
  messageBackfillToolContexts, messageBackfillToolPendingCalls, messageBackfillFailures,
} from "@nautilo/db";
import { MESSAGE_PAYLOAD_MAX_BYTES_V2 } from "../../message/message-payload-v2.ts";
import { conversationProductTypedDb as db, executeTypedConversationProductQuery as query,
  type ConversationProductCanonicalTransactionRunner, type ConversationProductPostgresExecutor,
} from "./postgres-conversation-product-store.ts";

/** An activation budget, never a limit on transcript length or pending calls.
 * Every step reads at most two individually bounded source rows and one metadata row. */
export const MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS = 50;
export type MessageBackfillToolContext = typeof messageBackfillToolContexts.$inferSelect;
export type MessageBackfillToolCallReference = typeof messageBackfillToolPendingCalls.$inferSelect;
export interface MessageBackfillToolSourceRow {
  id: number; revision: number; createdAt: string; role: string; opaque: boolean;
  toolCalls: string | null; toolName: string | null; oversized: boolean;
}
export interface MessageBackfillToolContextPort {
  row(id: number): Promise<MessageBackfillToolSourceRow | null>;
  next(after: {createdAt: string; id: number} | null): Promise<MessageBackfillToolSourceRow | null>;
  pending(after: number): Promise<MessageBackfillToolCallReference | null>;
  insert(reference: MessageBackfillToolCallReference): Promise<void>;
  remove(sequence: number): Promise<void>;
}
export function messageBackfillToolCall(row: MessageBackfillToolSourceRow, ordinal: number) {
  if (row.oversized) throw new TypeError("Canonical Tool context exceeds Message payload encoding");
  const calls: unknown = row.toolCalls === null ? [] : JSON.parse(row.toolCalls);
  if (!Array.isArray(calls)) throw new TypeError("Canonical Tool calls are invalid");
  const call: unknown = calls[ordinal];
  if (call === undefined) return null;
  if (typeof call !== "object" || call === null) throw new TypeError("Canonical Tool call is invalid");
  const record = call as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0
    || typeof record["name"] !== "string" || record["name"].length === 0) throw new TypeError("Canonical Tool call is invalid");
  return {id: record["id"], name: record["name"], identity: JSON.stringify(record)};
}

/** Same pending-duplicate/FIFO/reused-ID semantics as createLiveShadowToolResultCallIdResolver.
 * Comparisons reopen canonical source references; no content-derived state crosses activations. */
export async function advanceMessageBackfillToolContext(
  state: MessageBackfillToolContext, port: MessageBackfillToolContextPort,
): Promise<void> {
  const finish = (row: MessageBackfillToolSourceRow) => {
    state.afterCreatedAt = row.createdAt; state.afterMessageId = row.id;
    state.currentMessageId = null; state.callOrdinal = 0; state.comparisonSequence = 0;
  };
  for (let step = 0; step < MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS; step += 1) {
    if (state.phase === "ready" || state.phase === "invalid") return;
    if (state.phase === "clear") {
      const pending = await port.pending(0);
      if (pending !== null) await port.remove(pending.sequence);
      else {state.phase = "scan"; state.nextSequence = 0;}
      continue;
    }
    const row = state.currentMessageId === null
      ? await port.next(state.afterCreatedAt === null ? null : {createdAt: state.afterCreatedAt, id: state.afterMessageId})
      : await port.row(state.currentMessageId);
    if (row === null) {state.phase = "invalid"; return;}
    state.currentMessageId = row.id;
    if (row.opaque && (row.role === "assistant" || row.role === "tool")) {
      finish(row); state.phase = "clear"; continue;
    }
    try {
      if (row.oversized) throw new TypeError("Canonical Tool context exceeds Message payload encoding");
      if (row.role !== "assistant" && row.role !== "tool") {finish(row); continue;}
      const call = row.role === "assistant" ? messageBackfillToolCall(row, state.callOrdinal) : null;
      if (row.role === "assistant" && call === null) {finish(row); continue;}
      if (row.role === "tool" && row.toolName === null) throw new TypeError("Canonical Tool name is unavailable");
      const pending = await port.pending(state.comparisonSequence);
      if (pending === null) {
        if (row.role === "tool") throw new TypeError("Canonical Tool result is unpaired");
        state.nextSequence += 1;
        await port.insert({humanActorId: state.humanActorId, sequence: state.nextSequence,
          sourceMessageId: row.id, sourceRevision: row.revision, callOrdinal: state.callOrdinal});
        state.callOrdinal += 1; state.comparisonSequence = 0;
        continue;
      }
      const original = await port.row(pending.sourceMessageId);
      if (original === null || original.revision !== pending.sourceRevision || original.role !== "assistant" || original.opaque)
        throw new TypeError("Canonical Tool context reference changed");
      const retained = messageBackfillToolCall(original, pending.callOrdinal);
      if (retained === null) throw new TypeError("Canonical Tool context call disappeared");
      if (call !== null && retained.id === call.id) {
        if (retained.identity !== call.identity) throw new TypeError("Canonical pending Tool call conflicts");
        state.callOrdinal += 1; state.comparisonSequence = 0;
      } else if (row.role === "tool" && retained.name === row.toolName) {
        if (row.id === state.targetMessageId) {
          state.selectedMessageId = pending.sourceMessageId; state.selectedRevision = pending.sourceRevision;
          state.selectedCallOrdinal = pending.callOrdinal; state.phase = "ready";
        } else {await port.remove(pending.sequence); finish(row);}
      } else state.comparisonSequence = pending.sequence;
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError)) throw error;
      state.phase = "invalid";
    }
  }
}

/** SQL bounds individual source strings before they enter the process. Bodies are never selected. */
export async function readMessageBackfillToolSourceRow(executor: ConversationProductPostgresExecutor,
  input: {sessionId: string; messageId?: number; after?: {createdAt: string; id: number} | null;
    throughMessageId?: number},
): Promise<MessageBackfillToolSourceRow | null> {
  const oversized = sql<boolean>`case when ${sessionMessages.role} = 'assistant' then coalesce(octet_length(${sessionMessages.toolCalls}), 0)
    when ${sessionMessages.role} = 'tool' then coalesce(octet_length(${sessionMessages.toolName}), 0) else 0 end > ${MESSAGE_PAYLOAD_MAX_BYTES_V2}`;
  const [row] = await query(executor, db.select({id: sessionMessages.id, edit_revision: sessionMessages.editRevision,
    created_at: sql<string>`${sessionMessages.createdAt}::text`.as("created_at"), role: sessionMessages.role,
    opaque: sql<boolean>`${sessionMessages.content} is null`.as("opaque"),
    oversized: oversized.as("oversized"),
    tool_calls: sql<string | null>`case when ${oversized} or ${sessionMessages.role} <> 'assistant' then null else ${sessionMessages.toolCalls} end`.as("tool_calls"),
    tool_name: sql<string | null>`case when ${oversized} or ${sessionMessages.role} <> 'tool' then null else ${sessionMessages.toolName} end`.as("tool_name"),
  }).from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.sessionId),
    input.messageId === undefined ? undefined : eq(sessionMessages.id, input.messageId),
    input.after == null ? undefined : or(gt(sessionMessages.createdAt, sql`${input.after.createdAt}::timestamptz`),
      and(eq(sessionMessages.createdAt, sql`${input.after.createdAt}::timestamptz`), gt(sessionMessages.id, input.after.id))),
    input.throughMessageId === undefined ? undefined : or(lt(sessionMessages.createdAt,
      db.select({createdAt: sessionMessages.createdAt}).from(sessionMessages).where(eq(sessionMessages.id, input.throughMessageId))),
      and(eq(sessionMessages.createdAt, db.select({createdAt: sessionMessages.createdAt}).from(sessionMessages)
        .where(eq(sessionMessages.id, input.throughMessageId))), lte(sessionMessages.id, input.throughMessageId))),
  )).orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id)).limit(1));
  if (row === undefined) return null;
  return {id: Number(row.id), revision: Number(row.edit_revision), createdAt: String(row.created_at),
    role: String(row.role), opaque: row.opaque === true, oversized: row.oversized === true,
    toolCalls: row.tool_calls === null ? null : String(row.tool_calls), toolName: row.tool_name === null ? null : String(row.tool_name)};
}

export async function activeMessageBackfillToolContext(runner: ConversationProductCanonicalTransactionRunner, humanActorId: string) {
  return runner.transaction(async tx => {
    const [state] = await tx.select({messageId: messageBackfillToolContexts.targetMessageId,
      sessionId: messageBackfillToolContexts.sessionId, revision: messageBackfillToolContexts.targetRevision,
      failureMessageId: messageBackfillFailures.messageId})
      .from(messageBackfillToolContexts).leftJoin(messageBackfillFailures, and(
        eq(messageBackfillFailures.messageId, messageBackfillToolContexts.targetMessageId),
        eq(messageBackfillFailures.editRevision, messageBackfillToolContexts.targetRevision)))
      .where(eq(messageBackfillToolContexts.humanActorId, humanActorId));
    return state ?? null;
  }, {isolationLevel: "read committed"});
}

export function initialMessageBackfillToolContext(
  input: {humanActorId: string; sessionId: string; messageId: number; revision: number}, sourceRevision: number,
): MessageBackfillToolContext {
  return {humanActorId: input.humanActorId, sessionId: input.sessionId,
    targetMessageId: input.messageId, targetRevision: input.revision, sourceRevision,
    phase: "clear", afterCreatedAt: null, afterMessageId: 0, currentMessageId: null,
    callOrdinal: 0, comparisonSequence: 0, nextSequence: 0,
    selectedMessageId: null, selectedRevision: null, selectedCallOrdinal: null};
}

/** Caller already holds current policy/Room/Message authority. Never lock a Message after Session SHARE. */
export type MessageBackfillToolContextActivation = Readonly<{
  status: "more" | "ready" | "invalid";
  becameTerminal: boolean;
}>;

export async function activateMessageBackfillToolContext(runner: ConversationProductCanonicalTransactionRunner,
  input: {humanActorId: string; sessionId: string; messageId: number; revision: number; createdAt: Date},
): Promise<MessageBackfillToolContextActivation> {
  return runner.transaction(async (tx, executor) => {
    const [session] = await tx.select({revision: sessions.messageSourceRevision}).from(sessions)
      .where(eq(sessions.id, input.sessionId)).for("share");
    if (session === undefined) return {status: "more", becameTerminal: false};
    const initial = initialMessageBackfillToolContext(input, session.revision);
    await tx.insert(messageBackfillToolContexts).values(initial).onConflictDoNothing();
    const [state] = await tx.select().from(messageBackfillToolContexts)
      .where(eq(messageBackfillToolContexts.humanActorId, input.humanActorId)).for("update");
    if (state === undefined) return {status: "more", becameTerminal: false};
    const sameSource = state.sessionId === input.sessionId && state.targetMessageId === input.messageId
      && state.targetRevision === input.revision && state.sourceRevision === session.revision;
    const wasTerminal = sameSource && (state.phase === "ready" || state.phase === "invalid");
    if (!sameSource) Object.assign(state, initial);
    await advanceMessageBackfillToolContext(state, {
      row: messageId => readMessageBackfillToolSourceRow(executor, {sessionId: input.sessionId, messageId}),
      next: after => readMessageBackfillToolSourceRow(executor, {sessionId: input.sessionId, after,
        throughMessageId: input.messageId}),
      pending: async after => (await tx.select().from(messageBackfillToolPendingCalls).where(and(
        eq(messageBackfillToolPendingCalls.humanActorId, input.humanActorId), gt(messageBackfillToolPendingCalls.sequence, after),
      )).orderBy(asc(messageBackfillToolPendingCalls.sequence)).limit(1))[0] ?? null,
      insert: async reference => {await tx.insert(messageBackfillToolPendingCalls).values(reference);},
      remove: async sequence => {await tx.delete(messageBackfillToolPendingCalls).where(and(
        eq(messageBackfillToolPendingCalls.humanActorId, input.humanActorId), eq(messageBackfillToolPendingCalls.sequence, sequence)));},
    });
    await tx.update(messageBackfillToolContexts).set(state).where(eq(messageBackfillToolContexts.humanActorId, input.humanActorId));
    const status = state.phase === "ready" || state.phase === "invalid" ? state.phase : "more";
    return {status, becameTerminal: !wasTerminal && status !== "more"};
  }, {isolationLevel: "read committed"});
}

export async function prepareMessageBackfillToolContext(runner: ConversationProductCanonicalTransactionRunner,
  input: {humanActorId: string; sessionId: string; messageId: number; revision: number; createdAt: Date},
): Promise<"more" | "ready" | "invalid"> {
  return (await activateMessageBackfillToolContext(runner, input)).status;
}

/** Garbage collection is also resumable; never cascade a transcript-sized pending set. */
export async function discardMessageBackfillToolContext(runner: ConversationProductCanonicalTransactionRunner, humanActorId: string) {
  return runner.transaction(async tx => {
    const [state] = await tx.select().from(messageBackfillToolContexts)
      .where(eq(messageBackfillToolContexts.humanActorId, humanActorId)).for("update");
    if (state === undefined) return true;
    const page = await tx.select({sequence: messageBackfillToolPendingCalls.sequence}).from(messageBackfillToolPendingCalls)
      .where(eq(messageBackfillToolPendingCalls.humanActorId, humanActorId))
      .orderBy(asc(messageBackfillToolPendingCalls.sequence)).limit(MESSAGE_BACKFILL_TOOL_CONTEXT_STEPS);
    for (const row of page) await tx.delete(messageBackfillToolPendingCalls).where(and(
      eq(messageBackfillToolPendingCalls.humanActorId, humanActorId), eq(messageBackfillToolPendingCalls.sequence, row.sequence)));
    if (page.length > 0) return false;
    await tx.delete(messageBackfillToolContexts).where(eq(messageBackfillToolContexts.humanActorId, humanActorId));
    return true;
  }, {isolationLevel: "read committed"});
}
