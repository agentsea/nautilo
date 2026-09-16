import type { RoomEventKind } from "@nautilo/reflection";

export type { RoomEventKind } from "@nautilo/reflection";
export type RoomEventStatus = "active" | "superseded" | "resolved";

export type StenographerOperation =
  | {
      op: "append";
      kind: RoomEventKind;
      statement: string;
      sourceMessageIds: number[];
    }
  | {
      op: "supersede";
      eventSequence: number;
      kind: RoomEventKind;
      statement: string;
      sourceMessageIds: number[];
    }
  | {
      op: "resolve";
      eventSequence: number;
      statement: string;
      sourceMessageIds: number[];
    };

export interface StenographerOutput {
  operations: StenographerOperation[];
}

export interface EffectiveRoomEvent {
  id: string;
  roomId: string;
  sequence: number;
  kind: RoomEventKind;
  statement: string;
  status: RoomEventStatus;
  supersedesEventId?: string | null;
  resolvesEventId?: string | null;
}

export interface RoomEventRollupView {
  throughEventSequence: number;
  content: string;
  /** Cumulative raw-event contribution count when loaded from persistence. */
  sourceEventCount?: number;
}
