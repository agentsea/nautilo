import type { VoiceAudioEvent } from "@nautilo/types";

/** Resolve the exact Room visible in the full-screen Mobile chat route. */
export function activeRoomIdFromPathname(
  pathname: string | null | undefined,
): string | null {
  if (!pathname) return null;
  const match = /^\/chat\/([^/?#]+)(?:\/|$)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * D570 — voice is off by default and private audio is still not ambient.
 * A chunk reaches the player only when this client has voice enabled and is
 * currently showing the event's exact origin Room. Rejected chunks are not
 * retained here, so returning to the Room cannot replay them.
 */
export function shouldPlayRoomVoiceAudio(input: {
  event: VoiceAudioEvent;
  activeRoomId: string | null;
  enabled: boolean;
}): boolean {
  return input.enabled
    && input.activeRoomId !== null
    && input.event.roomId === input.activeRoomId;
}
