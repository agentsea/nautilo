import { createContext } from "react";

/** The ordinary runtime remains the only player and voice socket owner. */
export const CompanionVoiceContext = createContext<{
  roomId: string | null;
  pinnedRoomId: string | null;
  enabled: boolean;
  playing: boolean;
  prepare(): void;
  enable(roomId: string): void;
  release(roomId: string): void;
  stopTalking(): void;
} | null>(null);
