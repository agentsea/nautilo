export type DrawerKind =
  | { kind: "closed" }
  | { kind: "thread"; parentRoomId: string; subthreadRoomId: string; anchorMessageId: number }
  | { kind: "person"; personActorId: string }
  | { kind: "bot"; agentId: string }
  | { kind: "room"; roomId: string }
  | { kind: "relationship"; viewerActorId: string; counterpartActorId: string }
  | { kind: "subagent-transcript"; taskId: string; taskRunId?: string };

export interface DrawerState {
  current: DrawerKind;
  open: (kind: Exclude<DrawerKind, { kind: "closed" }>) => void;
  close: () => void;
  swapTo: (kind: Exclude<DrawerKind, { kind: "closed" }>) => void;
}
