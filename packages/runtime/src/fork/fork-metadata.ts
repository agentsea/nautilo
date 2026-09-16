import type { ChatMultimodalImagePart } from "@nautilo/types";
import type { CoalescedInput } from "../lane-coalescer";

/** Enough to rebuild the foreground HumanMessage (fork predecessors + fork turn). */
export type RegisteredTurnSlice = {
  message: string;
  attachmentTextBlocks: string[];
  multimodalImages: ChatMultimodalImagePart[];
};

export type ForkRunMetadata = {
  mode: "fork";
  parentThreadId: string;
  forkThreadId: string;
  checkpointThreadId: string;
  transcriptThreadId: string;
  sequence: number;
  parentJobId?: string;
  // M170 — slimmed to the in-flight-predecessor identity only. Predecessor
  // *content* now comes from the DB transcript rebuild (R1), so we no longer
  // copy the full slice / fingerprint into the fork run. The count drives the
  // transient `[FORK BACKGROUND]` marker (R2b).
  pendingTurns: Array<{
    sequence: number;
    turnId: string;
  }>;
};

export function coalescedToSlice(merged: CoalescedInput): RegisteredTurnSlice {
  return {
    message: merged.message,
    attachmentTextBlocks: merged.attachmentTextBlocks,
    multimodalImages: merged.multimodalImages,
  };
}

export type LaneTurnRegistration = {
  sequence: number;
  jobId: string;
  turnId: string;
  kind: "main" | "fork";
  mergedSlice: RegisteredTurnSlice;
};
