// Session-only model overrides. This module intentionally has no storage
// dependency: selections must reset when the app restarts.
const selectionsByServer = new Map<string, Map<string, string>>();

/** Returns this room's session override, or null to use the server default. */
export function getRoomModelSelection(serverId: string, roomId: string): string | null {
  return selectionsByServer.get(serverId)?.get(roomId) ?? null;
}

/** Sets this room's session-only model override. */
export function setRoomModelSelection(serverId: string, roomId: string, modelId: string | null): void {
  if (modelId === null) {
    const selectionsByRoom = selectionsByServer.get(serverId);
    selectionsByRoom?.delete(roomId);
    if (selectionsByRoom?.size === 0) selectionsByServer.delete(serverId);
    return;
  }
  let selectionsByRoom = selectionsByServer.get(serverId);
  if (!selectionsByRoom) {
    selectionsByRoom = new Map();
    selectionsByServer.set(serverId, selectionsByRoom);
  }
  selectionsByRoom.set(roomId, modelId);
}
