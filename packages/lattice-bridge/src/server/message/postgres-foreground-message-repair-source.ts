import {
  and,
  asc,
  eq,
  inArray,
  rooms,
  sessionMessages,
  sessions,
} from "@nautilo/db";

import { decodeMessagePayloadV2 } from "../../message/message-payload-v2.ts";
import type {
  ForegroundMessageRepairSource,
  ForegroundMessageRepairSourceRepresentationMode,
} from
  "./foreground-message-history-repair.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductPostgresHandle,
} from "./postgres-conversation-product-store.ts";
import {
  encodeLiveShadowOrdinaryPayloadV2,
  resolveLiveShadowToolResultCallIds,
} from "./postgres-live-shadow-client-verification.ts";

const MAX_SELECTED_MESSAGES_PER_QUERY = 256;

/** Load exact product bytes only for IDs already selected by prompt policy. */
export async function loadPostgresForegroundMessageRepairSources(input: Readonly<{
  product: ConversationProductPostgresHandle;
  readableNamespaceIds: readonly string[];
  messageIds: readonly number[];
  representationMode?: ForegroundMessageRepairSourceRepresentationMode;
}>): Promise<readonly ForegroundMessageRepairSource[]> {
  if (
    new Set(input.messageIds).size !== input.messageIds.length
    || input.messageIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    || input.readableNamespaceIds.length < 1
    || input.readableNamespaceIds.some((namespaceId, index) =>
      namespaceId.length < 1
      || (index > 0 && input.readableNamespaceIds[index - 1]! >= namespaceId)
    )
  ) throw new TypeError("Foreground Message repair selection is invalid");
  if (input.messageIds.length === 0) return Object.freeze([]);
  const representationMode = input.representationMode
    ?? "ordinary-and-protected";

  return input.product.transaction(async (transaction) => {
    const loadBatch = (selectedIds: readonly number[]) => {
      const structuralSelection = {
        message_id: sessionMessages.id,
        session_id: sessionMessages.sessionId,
        room_id: sessions.roomId,
        namespace_id: rooms.namespaceId,
        role: sessionMessages.role,
        human_turn_id: sessionMessages.humanTurnId,
        edit_revision: sessionMessages.editRevision,
        crypto_object_id: sessionMessages.cryptoObjectId,
        created_at: sessionMessages.createdAt,
        session_agent_id: sessions.agentId,
      };
      const selection = representationMode === "protected-only"
        ? structuralSelection
        : {
          ...structuralSelection,
          content: sessionMessages.content,
          tool_calls: sessionMessages.toolCalls,
          tool_name: sessionMessages.toolName,
        };
      return executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select(selection).from(sessionMessages)
          .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
          .innerJoin(rooms, eq(rooms.id, sessions.roomId))
          .where(and(
            inArray(rooms.namespaceId, [...input.readableNamespaceIds]),
            inArray(sessionMessages.id, [...selectedIds]),
          ))
          .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id)),
      );
    };
    const rows: Awaited<ReturnType<typeof loadBatch>>[number][] = [];
    for (
      let offset = 0;
      offset < input.messageIds.length;
      offset += MAX_SELECTED_MESSAGES_PER_QUERY
    ) {
      const selectedIds = input.messageIds.slice(
        offset,
        offset + MAX_SELECTED_MESSAGES_PER_QUERY,
      );
      const batch = await loadBatch(selectedIds);
      if (batch.length !== selectedIds.length) {
        throw new Error("Foreground Message repair selection changed");
      }
      rows.push(...batch);
    }
    if (rows.length !== input.messageIds.length) {
      throw new Error("Foreground Message repair selection changed");
    }
    const normalizedRows = rows.map((row) => Object.freeze({
      ...row,
      message_id: row.id,
      session_agent_id: row.agent_id,
    })).sort((left, right) => {
      const leftAt = left.created_at instanceof Date
        ? left.created_at.getTime()
        : Date.parse(String(left.created_at));
      const rightAt = right.created_at instanceof Date
        ? right.created_at.getTime()
        : Date.parse(String(right.created_at));
      if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) {
        throw new TypeError("Foreground Message repair timestamp is invalid");
      }
      return leftAt - rightAt || Number(left.message_id) - Number(right.message_id);
    });
    const protectedToolResultIndices = new Set<number>();
    const correlationRows = normalizedRows.map((row, index) => {
      // Existing protected rows own their call identity. Ordinary copies may
      // represent both a proposal and its redacted approval checkpoint; do not
      // infer another identity from that lossy projection. The repairer still
      // authenticates the exact stored row and compares its body/name, and will
      // not synthesize a Tool result if its protected identity is unavailable.
      if (typeof row.crypto_object_id === "string"
        && (row.role === "assistant" || row.role === "tool")) {
        if (row.role === "tool") protectedToolResultIndices.add(index + 1);
        return { ...row, content: null };
      }
      return row;
    });
    const toolResultIds = representationMode === "protected-only"
      ? new Map<number, string>()
      : resolveLiveShadowToolResultCallIds(correlationRows, {
        opaqueBodylessRows: true,
        onUnpairedToolResult: (index) => {
          protectedToolResultIndices.add(index);
        },
      });
    const byId = new Map<number, ForegroundMessageRepairSource>();
    for (let index = 0; index < normalizedRows.length; index += 1) {
      const row = normalizedRows[index]!;
      const messageId = Number(row.message_id);
      const role = row.role;
      if (
        !Number.isSafeInteger(messageId)
        || row.room_id === null
        || (
          role !== "user"
          && role !== "assistant"
          && role !== "tool"
          && role !== "system"
        )
      ) throw new TypeError("Foreground Message repair source is invalid");
      if (
        representationMode === "ordinary-and-protected"
        && "content" in row
        && row.content === null
        && (row.tool_calls !== null || row.tool_name !== null)
      ) {
        throw new TypeError(
          "Foreground Message repair source has incomplete ordinary content",
        );
      }
      const hasProtectedToolResultIdentity =
        protectedToolResultIndices.has(index + 1);
      const bytes = representationMode === "protected-only"
          || !("content" in row)
          || row.content === null
        ? null
        : encodeLiveShadowOrdinaryPayloadV2(
          row,
          toolResultIds.get(index + 1) ?? null,
        );
      try {
        const createdAt = row.created_at instanceof Date
          ? row.created_at.getTime()
          : Date.parse(String(row.created_at));
        if (!Number.isFinite(createdAt)) {
          throw new TypeError("Foreground Message repair timestamp is invalid");
        }
        byId.set(messageId, Object.freeze({
          messageId,
          sessionId: String(row.session_id),
          roomId: String(row.room_id),
          namespaceId: String(row.namespace_id),
          revision: Number(row.edit_revision),
          createdAt,
          authorRole: role,
          authorHumanTurnId: row.human_turn_id === null
            ? null
            : String(row.human_turn_id),
          sessionAgentId: row.session_agent_id === null
            ? null
            : String(row.session_agent_id),
          mappedCryptoObjectId: row.crypto_object_id === null
            ? null
            : String(row.crypto_object_id),
          payload: bytes === null ? null : decodeMessagePayloadV2(bytes),
          ...(hasProtectedToolResultIdentity
            ? { ordinaryComparison: "tool_result_protected_identity" as const }
            : {}),
        }));
      } finally {
        bytes?.fill(0);
      }
    }
    return Object.freeze(input.messageIds.map((id) => {
      const source = byId.get(id);
      if (source === undefined) {
        throw new Error("Foreground Message repair selection changed");
      }
      return source;
    }));
  }, { isolationLevel: "serializable" });
}
