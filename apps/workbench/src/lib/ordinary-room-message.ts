import type { NautiloApiClient } from "@nautilo/api-client/browser";
import { desktopAPI } from "./desktop";

type RoomBody = Parameters<NautiloApiClient["sendRoomMessage"]>[1];
type RoomSendResult = Awaited<ReturnType<NautiloApiClient["sendRoomMessage"]>>;
type DesktopRoomSender = (
  roomId: string,
  body: RoomBody,
) => ReturnType<NautiloApiClient["sendRoomMessage"]>;

function desktopOriginWasUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Desktop origin is unavailable");
}

/**
 * One ordinary Room-send seam for Workbench. Electron delegates the complete
 * authenticated request to main; browser remains a normal server-only chat.
 */
export async function sendOrdinaryRoomMessage(
  apiClient: NautiloApiClient,
  roomId: string,
  body: RoomBody,
  desktopSend: DesktopRoomSender | undefined = desktopAPI?.ordinaryChat?.sendRoomMessage,
): Promise<RoomSendResult> {
  if (!desktopSend) return apiClient.sendRoomMessage(roomId, body);
  try {
    return await desktopSend(roomId, body);
  } catch (error) {
    // Origin minting happens before Electron main sends the Room message. If
    // that local proof is unavailable, degrade to the same authenticated
    // server-only request the browser uses. This deliberately carries no
    // Current Folder provenance. Never retry an ambiguous/failed message POST.
    if (!desktopOriginWasUnavailable(error)) throw error;
    return apiClient.sendRoomMessage(roomId, body);
  }
}
