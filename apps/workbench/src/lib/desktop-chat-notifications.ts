import type { ImportantMessageArrivedEvent } from "@nautilo/types";
import type { DesktopImportantMessageNotificationInput } from "./desktop";

/**
 * Project one live important-arrival event onto the locked content-free
 * desktop boundary. Electron main independently validates every field and
 * owns all native copy.
 */
export function buildImportantArrivalNotificationRequest(
  event: ImportantMessageArrivedEvent,
): DesktopImportantMessageNotificationInput | null {
  if (
    event.type !== "notification.message.important" ||
    typeof event.messageId !== "string" ||
    event.messageId.length === 0 ||
    typeof event.senderDisplayName !== "string" ||
    typeof event.roomId !== "string" ||
    event.roomId.length === 0 ||
    typeof event.topLevelRoomId !== "string" ||
    event.topLevelRoomId.length === 0 ||
    typeof event.roomLabel !== "string"
  ) {
    return null;
  }

  const isSubthread = event.roomId !== event.topLevelRoomId;
  if (isSubthread && typeof event.parentRoomLabel !== "string") return null;

  return {
    messageId: event.messageId,
    senderDisplayName: event.senderDisplayName,
    roomId: event.roomId,
    topLevelRoomId: event.topLevelRoomId,
    roomLabel: event.roomLabel,
    ...(isSubthread ? { parentRoomLabel: event.parentRoomLabel } : {}),
  };
}
