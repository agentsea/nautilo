import type { RoomChatComposerCapabilities } from "@/hooks/use-room-chat-controller";
import type { MobilePlatformCapabilities } from "@/platform/capability-contract";

export function roomChatCapabilitiesForPlatform(
  platform: MobilePlatformCapabilities,
): RoomChatComposerCapabilities {
  return Object.freeze({
    attachments: platform.decisions.chatAttachments.status === "supported",
    voiceInput: platform.decisions.voice.status === "supported",
    voicePlayback: platform.decisions.voice.status === "supported",
  });
}

export function dockedRoomChatCapabilitiesForPlatform(
  platform: MobilePlatformCapabilities,
): RoomChatComposerCapabilities {
  const available = roomChatCapabilitiesForPlatform(platform);
  return Object.freeze({
    attachments: false,
    voiceInput: available.voiceInput,
    voicePlayback: false,
  });
}
