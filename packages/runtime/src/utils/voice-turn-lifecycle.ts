import { eventBus } from "../event-bus";
import type { SentenceDetector } from "./sentence-detector";

/** Scope upstream speech to the same cancellation authority as visible text. */
export function bindVoiceTurnLifecycle(input: {
  detector: SentenceDetector | null;
  signal: AbortSignal;
  userId: string | undefined;
  agentId: string | undefined;
  turnId: string;
}): (failed: boolean) => void {
  let cancelled = false;
  const abort = () => {
    if (!input.detector || !input.userId || !input.agentId || cancelled) return;
    cancelled = true;
    input.detector.reset();
    eventBus.emit({ type: "voice.turn.end", userId: input.userId, agentId: input.agentId, turnId: input.turnId, outcome: "aborted" });
  };
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  return failed => {
    input.signal.removeEventListener("abort", abort);
    input.detector?.reset();
    if (input.detector && input.userId && input.agentId) eventBus.emit({
      type: "voice.turn.end", userId: input.userId, agentId: input.agentId, turnId: input.turnId,
      outcome: failed || input.signal.aborted || cancelled ? "aborted" : "completed",
    });
  };
}
