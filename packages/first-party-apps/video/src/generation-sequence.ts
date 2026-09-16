import type { NautiloVideoGenerationRequest, NautiloVideoGenerationRequestResult } from "./bridge";

export type GenerationSource = NautiloVideoGenerationRequest["job"]["source"];
export type GenerationSequenceResult = {
  kind: "complete" | "stopped" | "needs-attention";
  submittedTakeIds: string[];
  completedTakeIds: string[];
  /** First scene not yet submitted. Never includes an uncertain submitted job. */
  nextIndex: number;
  message: string;
};

/**
 * A view-session sequencer over the existing, individually approved jobs.
 * Nothing here creates a receipt, retries a spend, or resumes paid work after reload.
 * The host retains every submitted job independently of this session.
 */
export async function runGenerationSequence(input: {
  sources: readonly GenerationSource[];
  signal: AbortSignal;
  prepare: (source: GenerationSource) => Promise<NautiloVideoGenerationRequest>;
  request: (request: NautiloVideoGenerationRequest) => Promise<NautiloVideoGenerationRequestResult>;
  waitUntilReady: (takeId: string, signal: AbortSignal) => Promise<void>;
  onProgress: (message: string) => void;
}): Promise<GenerationSequenceResult> {
  const submittedTakeIds: string[] = [];
  const completedTakeIds: string[] = [];
  let nextIndex = 0;
  const result = (kind: GenerationSequenceResult["kind"], message: string): GenerationSequenceResult =>
    ({ kind, submittedTakeIds, completedTakeIds, nextIndex, message });
  for (const [index, source] of input.sources.entries()) {
    if (input.signal.aborted) return result("stopped", "Sequence stopped. Submitted generations continue to your Media Bin.");
    try {
      input.onProgress(`Scene ${index + 1} of ${input.sources.length}: preparing exact cost.`);
      const request = await input.prepare(source);
      if (input.signal.aborted) return result("stopped", "Sequence stopped before the next approval.");
      // The parent may submit after consent while this request is pending.
      // A lost bridge response therefore cannot authorize replay.
      nextIndex = index + 1;
      const queued = await input.request(request);
      if (queued.kind === "submission-unknown") {
        submittedTakeIds.push(queued.takeId);
        nextIndex = index + 1;
        return result("needs-attention", "Submission could not be confirmed. Check this scene’s takes before generating again. No further scenes were submitted.");
      }
      if (queued.kind !== "queued") nextIndex = index;
      if (queued.kind !== "queued") return result("stopped", queued.kind === "cancelled"
        ? "Approval cancelled. No further scenes were submitted."
        : queued.kind === "expired"
          ? "The approval expired before submission. Generate again to review the current scene."
          : queued.message || "The approval could not be prepared. No generation was submitted. Your prompt and references are preserved; try Generate again.");
      nextIndex = index + 1;
      if (!queued.takeId) return result("needs-attention", "Generation started, but this host cannot track the sequence. Completed media still appears in the Media Bin. No further scenes were submitted.");
      submittedTakeIds.push(queued.takeId);
      if (input.signal.aborted) return result("stopped", "Sequence stopped. Submitted generations continue to your Media Bin.");
      input.onProgress(`Scene ${index + 1} of ${input.sources.length}: generating. Completed media is saved automatically.`);
      await input.waitUntilReady(queued.takeId, input.signal);
      completedTakeIds.push(queued.takeId);
    } catch (error) {
      if (input.signal.aborted) return result("stopped", "Sequence stopped. Submitted generations continue to your Media Bin.");
      return result("needs-attention", `${error instanceof Error ? error.message : "The sequence needs attention."} No further scenes were submitted. Completed media is retained.`);
    }
  }
  return result("complete", "Generation complete. Your video is saved in Workspace.");
}
