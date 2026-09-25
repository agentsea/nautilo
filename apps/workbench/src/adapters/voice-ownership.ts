export interface VoiceOwnershipInput {
  activeRoomId: string | null;
  activeRoomEnabled: boolean;
  companionRoomId: string | null;
}

/** Resolve the one Room owned by the one Workbench voice listener. */
export function resolveVoiceOwnership(input: VoiceOwnershipInput) {
  const roomId = input.companionRoomId ?? input.activeRoomId;
  const enabled = Boolean(roomId) && input.activeRoomEnabled;
  return {
    roomId,
    enabled,
    activeRoomSendVoiceMode: enabled && roomId === input.activeRoomId,
  };
}
