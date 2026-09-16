import type { TypingOther } from "./use-typing-others";

/**
 * D278 §8.3 — presence/typing strip model (model C, D313 refinement).
 *
 * Chip-collapse logic is pure and unit-testable via `buildPresenceStrip`.
 * The small external store below carries the runtime-updated
 * `agentStreamingVisibleOutput` bit without pushing ephemeral stream state
 * through the broader React tree.
 *
 * One row answers "who is responding right now". Humans and bots share one
 * `●●●` vocabulary. The asymmetry is *when* the chip shows:
 *
 * - Bot/Genie: show while the job is live (`agentRunning`) except while
 *   visible assistant text is actively streaming (`agentStreamingVisibleOutput`).
 *   Quiet gaps between bubbles (tool work, thinking, next message) show the
 *   chip again. Clears only on terminal job status or Stop.
 * - Human: persists for the whole time they are typing.
 *
 * Agent chip sorts first, then humans in arrival order. 3+ active → first two
 * chips + `+N`.
 */

export interface PresenceChip {
  readonly key: string;
  readonly kind: "agent" | "human";
  readonly label: string;
}

export interface PresenceStripModel {
  readonly visible: readonly PresenceChip[];
  readonly overflow: number;
}

export const MAX_VISIBLE_PRESENCE_CHIPS = 2;

/** D313 — module store updated by nautilo-runtime WS handlers. */
let agentStreamingVisibleOutputSnapshot = false;
const agentStreamingVisibleOutputListeners = new Set<() => void>();

export function subscribeAgentStreamingVisibleOutput(listener: () => void): () => void {
  agentStreamingVisibleOutputListeners.add(listener);
  return () => {
    agentStreamingVisibleOutputListeners.delete(listener);
  };
}

export function getAgentStreamingVisibleOutputSnapshot(): boolean {
  return agentStreamingVisibleOutputSnapshot;
}

/** Called by nautilo-runtime WS handlers only. */
export function setAgentStreamingVisibleOutput(next: boolean): void {
  if (agentStreamingVisibleOutputSnapshot === next) return;
  agentStreamingVisibleOutputSnapshot = next;
  for (const listener of agentStreamingVisibleOutputListeners) {
    listener();
  }
}

/** Test helper — reset store between tests. */
export function resetAgentStreamingVisibleOutputForTests(): void {
  setAgentStreamingVisibleOutput(false);
}

export function buildPresenceStrip({
  agentRunning,
  agentStreamingVisibleOutput,
  assistantName,
  others,
}: {
  readonly agentRunning: boolean;
  /** True while visible assistant text is actively streaming (D313 model C). */
  readonly agentStreamingVisibleOutput: boolean;
  readonly assistantName: string;
  readonly others: readonly TypingOther[];
}): PresenceStripModel {
  const chips: PresenceChip[] = [];
  // D313: hide the bot chip only while visible text streams; show again in
  // inter-message quiet gaps until the job reaches a terminal status.
  if (agentRunning && !agentStreamingVisibleOutput) {
    chips.push({ key: "agent", kind: "agent", label: assistantName });
  }
  for (const o of others) {
    chips.push({ key: `human:${o.userId}`, kind: "human", label: o.displayName });
  }
  const visible = chips.slice(0, MAX_VISIBLE_PRESENCE_CHIPS);
  return { visible, overflow: chips.length - visible.length };
}
