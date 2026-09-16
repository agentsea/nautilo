/**
 * D246 Wave 3 regression guard — synchronized transcript sizing.
 *
 * Mirrors upstream `ThreadPrimitive.Messages`, which subscribes to the
 * synchronized AUI thread state (`useAuiState((s) => s.thread.messages.length)`)
 * rather than the legacy runtime thread. During a room load/reset the runtime
 * message array can be ahead of assistant-ui's synchronized client lookup: the
 * runtime has already seeded N messages, but the `tapClientLookup` inside
 * `ThreadClient` has not yet rebuilt to match. If the transcript's count were
 * sourced from the runtime array, `ThreadPrimitive.MessageByIndex` would
 * resolve index 0 through an empty lookup and throw
 * `tapClientLookup: Index 0 out of bounds (length: 0)` (the AppErrorBoundary
 * `useClientLookup` crash observed on a deployed instance after de0a8e8e8).
 *
 * `deriveTranscriptSync` is the pure, deterministic core of the fix. It produces
 * the `count` + per-index stable ids for `TranscriptWindow` from the
 * SYNCHRONIZED AUI messages only. The count keeps window geometry aligned with
 * the lookup, while each id is passed to the assistant-ui id-based custom-list
 * provider so row identity survives reorder and contraction. The runtime array
 * is never consulted for sizing, so it can never lead the lookup. This is the
 * same synchronization seam `ThreadPrimitive.Messages` relies on; we do not
 * swallow the exception or add try/catch.
 *
 * Extracted as a pure helper so the race (runtime ahead of synchronized AUI
 * state) can be modeled deterministically in
 * `conversation-transcript-sync.test.ts` without standing up a real
 * assistant-ui runtime/store under bun:test.
 */

/** Minimal message shape the synchronizer needs (only `id`). */
export interface TranscriptMessageLike {
  readonly id: string | number;
}

/** Inputs `ConversationTranscript` derives from synchronized AUI state. */
export interface TranscriptSyncPlan {
  /**
   * Count handed to `TranscriptWindow`. Always `synchronizedMessages.length` —
   * never the runtime count — so window geometry stays in lookup bounds.
   */
  readonly count: number;
  /** Per-index key (message id) for `TranscriptWindow.getItemKey`. */
  readonly keys: readonly string[];
  /** The newest synchronized canonical message id, or null for an empty room. */
  readonly latestMessageId: string | null;
}

/**
 * Derive the `TranscriptWindow` count + per-index keys from the synchronized
 * AUI thread messages. The runtime message array is deliberately NOT an
 * input: it may lead the synchronized lookup during a room load/reset, and
 * sizing off it is exactly the regression this guard exists to prevent.
 */
export function deriveTranscriptSync(
  synchronizedMessages: readonly TranscriptMessageLike[],
): TranscriptSyncPlan {
  // Assistant UI's synchronized thread is the ordered, de-duplicated
  // canonical list. Keep the exact same per-index keys used by the virtual
  // lookup; action-rail tail state must never change its count or geometry.
  const keys = synchronizedMessages.map((m) => String(m.id));
  return {
    count: keys.length,
    keys,
    latestMessageId: keys.at(-1) ?? null,
  };
}

/**
 * Deterministic model of `TranscriptWindow`'s tail-anchored geometry against a
 * client lookup of `lookupLength` entries. Returns the positions selected for a
 * bottom-anchored, short-room (non-windowed) transcript — i.e. every index in
 * `[0, count)`. The windowing layer only ever narrows this range, so the full
 * `[0, count)` set is the worst geometry the synchronized lookup must describe.
 *
 * Used by the regression test to prove that when `count` is sourced from the
 * synchronized lookup length, the selected positions are always a subset of
 * `[0, lookupLength)`, even when the runtime array is ahead.
 */
export function renderIndicesForCount(count: number): readonly number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => i);
}
