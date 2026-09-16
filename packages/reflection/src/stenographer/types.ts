export const ROOM_EVENT_KINDS = [
  "decision",
  "commitment",
  "goal",
  "state_change",
  "fact",
  "preference_or_norm",
  "open_question",
  "risk",
] as const;

export type RoomEventKind = (typeof ROOM_EVENT_KINDS)[number];
export type RoomEventStatus = "active" | "superseded" | "resolved";

export type StenographerProposalOperation =
  | {
      op: "append";
      kind: RoomEventKind;
      statement: string;
      sourceReferences: string[];
    }
  | {
      op: "supersede";
      eventReference: string;
      kind: RoomEventKind;
      statement: string;
      sourceReferences: string[];
    }
  | {
      op: "resolve";
      eventReference: string;
      statement: string;
      sourceReferences: string[];
    };

export interface StenographerProposal {
  operations: StenographerProposalOperation[];
}

export interface StenographerEvidenceRow {
  createdAt: Date;
  role: "user" | "assistant" | "tool";
  displayLabel: string;
  text: string;
  conversationalBoundary: boolean;
}

export type StenographerPriorContextRow = Omit<
  StenographerEvidenceRow,
  "conversationalBoundary"
>;

export interface StenographerJournalEvent {
  localReference: string;
  kind: string;
  statement: string;
  active: boolean;
}

export interface StenographerExtractionSnapshot {
  priorRows: readonly StenographerPriorContextRow[];
  rows: readonly StenographerEvidenceRow[];
  latestRollup: string | null;
  visibleEvents: readonly StenographerJournalEvent[];
  /** Protected planning must recheck empty assistant bodies after opening. */
  hasConversationalContent: boolean;
}

export interface StenographerCompactionEvent {
  sequence: number;
  kind: RoomEventKind;
  statement: string;
  status: RoomEventStatus;
}

export interface StenographerCompactionRollup {
  throughEventSequence: number;
  content: string;
  sourceEventCount?: number;
}

export type StenographerModelInvoker = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;
