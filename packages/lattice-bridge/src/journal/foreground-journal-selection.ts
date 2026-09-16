import type { RoomEventPayloadBindingV1 } from "./room-event-payload-v1.ts";
import type { RoomEventRollupPayloadBindingV1 } from
  "./room-event-rollup-payload-v1.ts";

export type ForegroundJournalProtectedMapping =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "mapped"; cryptoObjectId: string }>;

export type ForegroundJournalSelectedEvent = Readonly<{
  kind: "event";
  rebuildGeneration: number;
  status: "active" | "superseded" | "resolved";
  binding: RoomEventPayloadBindingV1;
  payload:
    | Readonly<{
        kind: "legacy_event";
        protectedMapping: ForegroundJournalProtectedMapping;
      }>
    | Readonly<{
        kind: "reflection_record";
        recordId: string;
        lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
        structuralHeight: number;
        processingGeneration: number;
        ordinaryRepresentationGeneration: number | null;
        protectedMapping:
          | Readonly<{ status: "missing" }>
          | Readonly<{
              status: "mapped";
              representationGeneration: number;
              cryptoObjectId: string;
            }>;
      }>;
}>;

export type ForegroundJournalSelectedRollup = Readonly<{
  kind: "rollup";
  rebuildGeneration: number;
  binding: RoomEventRollupPayloadBindingV1;
  protectedMapping: ForegroundJournalProtectedMapping;
}>;

/** Exact content-free Journal inventory selected before repair. */
export interface ForegroundJournalSelectionSnapshot {
  readonly roomId: string;
  readonly namespaceId: string;
  readonly rebuildGeneration: number;
  readonly rollup: ForegroundJournalSelectedRollup | null;
  readonly events: readonly ForegroundJournalSelectedEvent[];
}

export interface ForegroundJournalSelectionPort {
  readonly selectCurrent: (input: Readonly<{
    roomId: string;
    namespaceId: string;
    maximumEvents: number;
  }>) => Promise<ForegroundJournalSelectionSnapshot | null>;
}

export type ForegroundJournalHistoryResult =
  | Readonly<{
      status: "verified";
      journal: Readonly<{
        rollup: Readonly<{
          throughEventSequence: number;
          content: string;
        }> | null;
        events: readonly Readonly<{
          id: string;
          roomId: string;
          sequence: number;
          kind: RoomEventPayloadBindingV1["kind"];
          statement: string;
          status: "active" | "superseded" | "resolved";
          supersedesEventId?: string | null;
          resolvesEventId?: string | null;
        }>[];
      }>;
      provenance: "existing" | "repaired";
      repairedCount: number;
      includesReflectionRecord: boolean;
      verification: "authenticated" | "independent_parity";
      ordinaryRestoredCount: number;
    }>
  | Readonly<{
      status: "waiting_for_authority" | "unsupported" | "failed";
      reason: string;
      /** Exact selected size when selection completed before the outcome. */
      selectedCount?: number;
    }>;
