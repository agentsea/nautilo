import { eventBus } from "@nautilo/runtime";
import { warn } from "@nautilo/logger";
import {
  getImportantMessageArrivals,
  listHumanUserIdsInRoom,
} from "@nautilo/trust";
import {
  audienceForBridgedServerEvent,
  broadcast,
  publishImportantMessageArrived,
  recomputeAndPublishNotificationState,
  roomIdFromLaneKey,
} from "./ws-publisher";
import type { ServerEvent } from "@nautilo/types";
import { messageNewDeliveryFacts } from "./message-new-delivery-facts";

/**
 * When a new message lands in a room, recompute + publish the
 * canonical per-recipient notification delta. Hooked here (not in dispatch.ts)
 * because BOTH the human
 * peer-broadcast path and the assistant runtime-executor path emit `message.new`
 * through the bus — this is the single chokepoint. Recipients = all human room
 * members minus the (human) sender; the per-recipient fan-out + emit-on-change
 * gate lives in the notification-state query service.
 */
async function publishUnreadForNewMessage(event: ServerEvent): Promise<void> {
  if (event.type !== "message.new") return;
  const roomId = roomIdFromLaneKey(event.laneKey);
  if (!roomId) return;
  const { senderUserId } = messageNewDeliveryFacts(event);
  const humans = await listHumanUserIdsInRoom(roomId);
  const recipients = senderUserId ? humans.filter((u) => u !== senderUserId) : humans;
  await recomputeAndPublishNotificationState({
    roomId,
    recipientUserIds: recipients,
  });
}

async function publishImportantArrivalForNewMessage(
  event: ServerEvent,
): Promise<void> {
  if (event.type !== "message.new") return;
  const { messageId } = messageNewDeliveryFacts(event);
  if (messageId === null) return;
  const arrivals = await getImportantMessageArrivals(messageId);
  for (const arrival of arrivals) {
    publishImportantMessageArrived(arrival);
  }
}

/**
 * Bridges the runtime event bus to the WebSocket publisher.
 * Call once on server startup. Idempotent — repeated `createApp()` in
 * the same process (integration tests) must not stack duplicate
 * `eventBus.on` handlers.
 */
let eventBridgeListener: ((event: ServerEvent) => void) | null = null;

/** Workspace committed mutation truth is authorized and delivered by its SSE/outbox path only. */
export function shouldBridgeRuntimeEventToWebSocket(event: ServerEvent): boolean {
  return event.type !== "document.mutation.committed" && event.type !== "voice.turn.end";
}

export function startEventBridge() {
  if (eventBridgeListener) return;
  eventBridgeListener = (event: ServerEvent) => {
    if (!shouldBridgeRuntimeEventToWebSocket(event)) return;
    broadcast(event, audienceForBridgedServerEvent(event));
    if (event.type === "message.new") {
      void publishUnreadForNewMessage(event).catch((err) => {
        warn(
          `[ws]  unread recompute failed for message.new: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        );
      });
      void publishImportantArrivalForNewMessage(event).catch((err) => {
        warn(
          `[ws]  important-arrival classification failed for message.new: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        );
      });
    }
  };
  eventBus.on(eventBridgeListener);
}
