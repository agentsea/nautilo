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

/** Exact snapshot positions disclosed to one extraction model invocation. */
export interface StenographerExtractionModelExposure {
  readonly currentRowPositions: readonly number[];
  readonly priorRowPositions: readonly number[];
  readonly latestRollupIncluded: boolean;
  readonly visibleEventReferences: readonly string[];
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

/** Exact journal inputs disclosed to one compaction model invocation. */
export interface StenographerCompactionModelExposure {
  readonly previousRollupThroughEventSequence: number | null;
  readonly selectedEventSequences: readonly number[];
  readonly protectedTailEventSequences: readonly number[];
}

export type StenographerModelInvoker = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;
