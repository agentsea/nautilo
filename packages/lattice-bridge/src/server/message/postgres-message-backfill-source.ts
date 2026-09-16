import { and, eq, sessions, sessionMessages, messageBackfillToolContexts, sql } from "@nautilo/db";
import { conversationProductTypedDb as db, executeTypedConversationProductQuery as query,
  type ConversationProductPostgresExecutor } from "./postgres-conversation-product-store.ts";
import { encodeLiveShadowOrdinaryPayloadV2 } from "./postgres-live-shadow-client-verification.ts";
import { MESSAGE_PAYLOAD_MAX_BYTES_V2 } from "../../message/message-payload-v2.ts";
import { messageBackfillToolCall, readMessageBackfillToolSourceRow } from "./message-backfill-tool-context.ts";

/** Exact source under current consumption/Room/Message authority. Session SHARE fences
 * the prepared transcript generation. All following Message reads are unlocked, preventing
 * a Session -> Message inversion against canonical mutations. A missing context is retryable. */
export async function readMessageBackfillOrdinarySource(executor: ConversationProductPostgresExecutor,
  input: Readonly<{humanActorId: string; sessionId: string; messageId: number; revision: number}>,
): Promise<Uint8Array | null> {
  const [session] = await query(executor, db.select({message_source_revision: sessions.messageSourceRevision})
    .from(sessions).where(eq(sessions.id, input.sessionId)).for("share"));
  if (session === undefined) return null;
  const oversized = sql<boolean>`coalesce(octet_length(${sessionMessages.content}), 0) + coalesce(octet_length(${sessionMessages.toolCalls}), 0) + coalesce(octet_length(${sessionMessages.toolName}), 0) > ${MESSAGE_PAYLOAD_MAX_BYTES_V2}`;
  const [row] = await query(executor, db.select({message_id: sessionMessages.id, session_id: sessionMessages.sessionId,
    role: sessionMessages.role, created_at: sessionMessages.createdAt,
    oversized: oversized.as("oversized"),
    content: sql<string | null>`case when ${oversized} then null else ${sessionMessages.content} end`.as("content"),
    tool_calls: sql<string | null>`case when ${oversized} then null else ${sessionMessages.toolCalls} end`.as("tool_calls"),
    tool_name: sql<string | null>`case when ${oversized} then null else ${sessionMessages.toolName} end`.as("tool_name"),
  }).from(sessionMessages).where(and(eq(sessionMessages.id, input.messageId), eq(sessionMessages.sessionId, input.sessionId),
    eq(sessionMessages.editRevision, input.revision))));
  if (row?.oversized === true) throw new TypeError("Canonical source exceeds Message payload encoding");
  if (!row || row.content === null) return null;
  let toolCallId: string | null = null;
  if (row.role === "tool") {
    const [context] = await query(executor, db.select({phase: messageBackfillToolContexts.phase,
      selected_message_id: messageBackfillToolContexts.selectedMessageId, selected_revision: messageBackfillToolContexts.selectedRevision,
      selected_call_ordinal: messageBackfillToolContexts.selectedCallOrdinal,
    }).from(messageBackfillToolContexts).where(and(eq(messageBackfillToolContexts.humanActorId, input.humanActorId),
      eq(messageBackfillToolContexts.sessionId, input.sessionId), eq(messageBackfillToolContexts.targetMessageId, input.messageId),
      eq(messageBackfillToolContexts.targetRevision, input.revision),
      eq(messageBackfillToolContexts.sourceRevision, Number(session.message_source_revision)))));
    if (context?.phase === "invalid") throw new TypeError("Canonical Tool-result correlation is invalid");
    if (context?.phase !== "ready" || context.selected_message_id === null
      || context.selected_revision === null || context.selected_call_ordinal === null) return null;
    const original = await readMessageBackfillToolSourceRow(executor,
      {sessionId: input.sessionId, messageId: Number(context.selected_message_id)});
    if (original === null || original.revision !== Number(context.selected_revision) || original.role !== "assistant" || original.opaque) return null;
    const call = messageBackfillToolCall(original, Number(context.selected_call_ordinal));
    if (call === null || call.name !== row.tool_name) return null;
    toolCallId = call.id;
  }
  return encodeLiveShadowOrdinaryPayloadV2(row, toolCallId);
}
