import type { RoomSummaryDto } from "@nautilo/types";

/**
 * Tabs are UI metadata layered on server Rooms — they are not persisted Room
 * entities on the server (Phase 1).
 */
export interface WorkbenchRoomSummary extends RoomSummaryDto {
  pinned: boolean;
  /** True when the Room is locally open in the tab rail. */
  tabOpen: boolean;
  /** Legacy v1 flag; true means the user explicitly closed this tab. */
  closedTab: boolean;
  /** Last time this room was activated locally (ms since epoch). */
  lastOpenedAt: number | null;
  /** Stable user-controlled order in the local tab rail. */
  tabOrder: number | null;
}

export type RoomNavigationStatus =
  | "guest"
  | "loading"
  | "ready"
  | "error";

export interface RoomNavigationState {
  rooms: WorkbenchRoomSummary[];
  /** Resolved selection when valid; null when none or unresolved missing route target. */
  activeRoomId: string | null;
  activeRoom: WorkbenchRoomSummary | null;
  /** Structured outcome for stale URL / empty list UX (Phase 3+). */
  activeResolution: ActiveRoomResolution;
  status: RoomNavigationStatus;
  roomListError: string | null;
  lastLoadedAt: number | null;
}

export type ActiveRoomResolution =
  | { kind: "selected"; roomId: string }
  | { kind: "missing"; roomId: string }
  | { kind: "none" };

export interface RoomNavigationTargetOptions {
  /** One-shot cross-chat target consumed by Conversation after Room activation. */
  targetMessageId?: string | number;
}

export interface RoomNavigationActions {
  refreshRooms: () => Promise<void>;
  registerBeforeActiveRoomChange?: (
    listener: (nextRoomId: string | null) => void,
  ) => () => void;
  setActiveRoom: (roomId: string, options?: RoomNavigationTargetOptions) => void;
  createRoom: (label: string) => Promise<void>;
  openTabForRoom: (roomId: string) => void;
  pinRoom: (roomId: string) => void;
  unpinRoom: (roomId: string) => void;
  closeTabForRoom: (roomId: string) => void;
  restoreClosedTabForRoom: (roomId: string) => void;
  reorderOpenTabs: (orderedRoomIds: string[]) => void;
  renameRoom: (roomId: string, label: string) => Promise<void>;
}

export interface RoomNavigationAPI extends RoomNavigationState, RoomNavigationActions {}
