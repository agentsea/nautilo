import type { RoomEventKind } from "@nautilo/reflection";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";

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
  /** Exact current native Record or legacy event disclosed to a model. */
  modelExposureDependency?: DurableModelExposureDependency;
}

export interface RoomEventRollupView {
  id?: string;
  throughEventSequence: number;
  content: string;
  /** Cumulative raw-event contribution count when loaded from persistence. */
  sourceEventCount?: number;
  compactorVersion?: string;
  /** This rollup's exact source coordinate as disclosed to a later model. */
  modelExposureDependency?: DurableModelExposureDependency;
  /** Inputs disclosed when this rollup was produced; absent on legacy rows. */
  modelExposureDependencies?: readonly DurableModelExposureDependency[];
}
