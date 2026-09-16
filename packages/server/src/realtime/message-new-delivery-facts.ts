import type { ServerEvent } from "@nautilo/types";

type MessageNewServerEvent = Extract<ServerEvent, { type: "message.new" }>;
type ProtectedMessageNewServerEvent = Extract<
  MessageNewServerEvent,
  { protection: "protected" }
>;

function isProtectedMessageNew(
  event: MessageNewServerEvent,
): event is ProtectedMessageNewServerEvent {
  return "protection" in event && event.protection === "protected";
}

export type MessageNewDeliveryFacts = Readonly<{
  readonly messageId: number | null;
  readonly senderUserId: string | null;
}>;

/**
 * Extracts only reviewed content-free delivery facts from either realtime
 * representation. Protected message content is deliberately unreachable
 * through this adapter.
 */
export function messageNewDeliveryFacts(
  event: MessageNewServerEvent,
): MessageNewDeliveryFacts {
  let rawMessageId: string;
  let senderUserId: string | undefined;
  if (isProtectedMessageNew(event)) {
    rawMessageId = event.message.projection.messageId;
    senderUserId =
      event.message.projection.role === "user"
        ? event.message.projection.sourceUserId
        : undefined;
  } else {
    rawMessageId = event.messageId;
    senderUserId = event.senderUserId;
  }
  const parsedMessageId = Number(rawMessageId);
  const messageId =
    Number.isSafeInteger(parsedMessageId) && parsedMessageId > 0
      ? parsedMessageId
      : null;
  return Object.freeze({
    messageId,
    senderUserId:
      typeof senderUserId === "string" && senderUserId.length > 0
        ? senderUserId
        : null,
  });
}
