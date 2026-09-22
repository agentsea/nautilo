import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ProtectedMessageStructuralProjectionV2, ServerEvent } from "@nautilo/types";
import type { RoomHistoryShadowReadResponseV1 } from "@nautilo/api-client/browser";
import type { RoomHistoryShadowReadAdapter, StoredSessionMessageDto } from "./session-rehydrate";
import {
  reconcileCanonicalHumanMessage,
  settleHumanMessageVerification,
} from "./message-new-reconciliation";

type HumanShadowEvent = Extract<ServerEvent, {
  type: "message.human_peer_shadow" | "message.shared_agent_shadow";
}>;

/** Called only after local authentication, for any displayed Room (including
 * a child). The routing layer never turns raw ciphertext into a message. */
export function projectVerifiedFullHumanEvent(
  projection: ProtectedMessageStructuralProjectionV2,
  content: string,
  logicalMessageKey: string,
): Extract<ServerEvent, { type: "message.new"; content: string }> {
  if (projection.role !== "user" || projection.sourceUserId === undefined) {
    throw new Error("Verified Human projection required");
  }
  return {
    type: "message.new",
    laneKey: `room:${projection.roomId}`,
    messageId: projection.messageId,
    logicalMessageKey,
    role: "user",
    content,
    attachments: [],
    sourceUserId: projection.sourceUserId,
    createdAt: projection.createdAt,
    editRevision: projection.editRevision,
    ...(projection.replyToMessageId == null ? {} : { replyToMessageId: Number(projection.replyToMessageId) }),
  };
}

/** Read the durable accepted message, not its possibly expired send request. */
export async function readPendingFullHumanMessage(input: Readonly<{
  event: HumanShadowEvent;
  reader: RoomHistoryShadowReadAdapter;
  loadSidecar: () => Promise<RoomHistoryShadowReadResponseV1>;
}>): Promise<StoredSessionMessageDto> {
  if (input.event.wireVersion !== 2) throw new Error("Full event required");
  const projection = input.event.protectedMessage.projection;
  if (projection.role !== "user" || projection.sourceUserId === undefined) {
    throw new Error("Human projection required");
  }
  const sidecar = await input.loadSidecar();
  if (sidecar.status !== "ready" || sidecar.records.length !== 1
    || !("representationMode" in sidecar.records[0])
    || sidecar.records[0].representationMode !== "protected-only") {
    throw new Error("Protected-only history required");
  }
  const matches = (coordinate: typeof sidecar.selectedCoordinates[number]) =>
    coordinate.sessionId === projection.sessionId
    && String(coordinate.messageId) === projection.messageId
    && coordinate.editRevision === projection.editRevision
    && coordinate.role === projection.role
    && coordinate.logicalMessageKey === input.event.logicalMessageKey;
  if (sidecar.selectedCoordinates.length !== 1
    || !matches(sidecar.selectedCoordinates[0]) || !matches(sidecar.records[0].coordinate)) {
    throw new Error("Protected history selection changed");
  }
  const messages = await input.reader.reconcile({
    roomId: projection.roomId, sidecar, requireVerified: true,
    messages: [{ id: projection.messageId, role: "user", content: "",
      createdAt: projection.createdAt, editRevision: projection.editRevision,
      sourceUserId: projection.sourceUserId, logicalMessageKey: input.event.logicalMessageKey }],
  });
  const opened = messages[0];
  if (messages.length !== 1 || opened?.id !== projection.messageId
    || opened.role !== "user"
    || opened.editRevision !== projection.editRevision
    || opened.sourceUserId !== projection.sourceUserId
    || opened.logicalMessageKey !== input.event.logicalMessageKey) {
    throw new Error("Protected history coordinates changed");
  }
  return opened;
}

/** Drain only the encrypted events whose missing key may now be available. */
export function takePendingFullHumanEvents(
  pending: Map<string, HumanShadowEvent>,
  delivery: Readonly<{ namespaceId: string; keyClass: "human" | "ai" }>,
): readonly HumanShadowEvent[] {
  const ready: HumanShadowEvent[] = [];
  for (const event of pending.values()) {
    if (event.wireVersion !== 2
      || event.protectedMessage.projection.namespaceId !== delivery.namespaceId
      || event.protectedMessage.protectedPayload.status !== "encrypted"
      || event.protectedMessage.protectedPayload.keyClass !== delivery.keyClass) continue;
    pending.delete(event.logicalMessageKey);
    ready.push(event);
  }
  return ready;
}

/** Only call with the projection and payload of a locally verified Full event. */
export function reconcileVerifiedFullHumanMessage(
  messages: readonly ThreadMessageLike[],
  projection: ProtectedMessageStructuralProjectionV2,
  content: string,
  logicalMessageKey: string,
  viewerId: string | null,
): readonly ThreadMessageLike[] {
  if (projection.role !== "user" || projection.sourceUserId === undefined) return messages;
  const current = messages.find((message) => String(message.id) === projection.messageId);
  const revision = current?.metadata?.custom?.editRevision;
  // A delayed original event must not undo an edit already loaded from history.
  if (typeof revision === "number" && revision > projection.editRevision) return messages;
  const reconciled = reconcileCanonicalHumanMessage(messages, {
    messageId: projection.messageId,
    createdAt: projection.createdAt,
    sourceUserId: projection.sourceUserId,
    content,
    attachments: [],
    logicalMessageKey,
    editRevision: projection.editRevision,
    ...(projection.replyToMessageId == null ? {} : {
      replyToMessageId: Number(projection.replyToMessageId),
    }),
  }, viewerId);
  return settleHumanMessageVerification(reconciled, projection.messageId, {
    status: "verified", content,
  });
}
