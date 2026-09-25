import { createContext } from "react";

/** The ordinary runtime remains the only player and voice socket owner. */
export const CompanionVoiceContext = createContext<{
  roomId: string | null;
  pinnedRoomId: string | null;
  enabled: boolean;
  playing: boolean;
  canStopTalking: boolean;
  prepare(): void;
  enable(roomId: string): void;
  release(roomId: string): void;
  setEnabled(enabled: boolean): void;
  stopTalking(): void;
} | null>(null);
