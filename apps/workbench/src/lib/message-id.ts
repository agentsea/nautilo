/**
 * D087 UX hotfix — unique message-id generator.
 *
 * Extracted from `adapters/nautilo-runtime.tsx` so the
 * "never collides under burst dispatch" invariant is testable in
 * isolation and doesn't regress.
 *
 * ------------------------------------------------------------------
 * History / why this exists
 * ------------------------------------------------------------------
 *
 * assistant-ui's MessageRepository throws when two messages share an
 * id; without a surrounding error boundary that throw unmounts the
 * whole React tree, leaving the user with a blank viewport.
 *
 * Several call sites in nautilo-runtime used `${prefix}-${Date.now()}`
 * as the id. For hand-typed prose a user can't append two messages
 * inside the same millisecond, so collisions never surfaced. But the
 * D087 §1.6 TurnActionBar's Accept-all handler dispatches N
 * synthetic user messages in a tight synchronous loop — every one
 * of them hits Date.now() with the same value and the repository
 * rejects the duplicates. React unmounts. Silent crash.
 *
 * The id shape below combines:
 *   - wall-clock ms (keeps ids roughly time-sortable in logs)
 *   - a monotonic in-process counter, wrapped at 16 bits (guarantees
 *     uniqueness inside a millisecond burst up to 65536 messages —
 *     way more headroom than any real app ever needs)
 *   - a 16-bit random suffix (belt-and-suspenders for hypothetical
 *     multi-window / multi-tab scenarios where two renderer processes
 *     might share a date value AND a counter seed)
 *
 * Format: `${prefix}-${ms}-${hexSeq}-${hexRand}`
 *
 * Example: `user-1776941934501-00a3-b2f4`
 */

let _msgIdSeq = 0;

/**
 * Generate a unique id of the form `${prefix}-${ms}-${seq}-${rand}`.
 * Safe to call any number of times in the same tick without
 * collision.
 */
export function newMessageId(prefix: string): string {
  _msgIdSeq = (_msgIdSeq + 1) & 0xffff;
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${prefix}-${Date.now()}-${_msgIdSeq.toString(16).padStart(4, "0")}-${rand}`;
}

/**
 * assistant-ui's MessageRepository throws if two thread rows share an id.
 * After checkpoint resume (e.g. approval on a subagent tool), the server
 * may emit `tool.start` again for the same `toolCallId` — duplicate
 * `tool-${toolCallId}` bubbles. Keep the first occurrence (matches the
 * card the user already saw).
 *
 * `id` is typed as `string | undefined` to match assistant-ui's
 * `ThreadMessageLike` shape (the id is optional in their public type
 * even though every row our runtime emits sets one). Rows without an
 * id can't be deduplicated by definition — pass them through unchanged
 * and let assistant-ui's own validators surface the missing-id case.
 */
export function dedupeThreadMessagesById<T extends { id?: string | undefined }>(
  messages: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of messages) {
    const id = m.id;
    if (id === undefined || id === "") {
      out.push(m);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  return out;
}

/**
 * Test-only: reset the internal counter. Production code must not
 * import this — its sole purpose is keeping unit tests isolated from
 * each other when they each want to start from seq=0.
 */
export function _resetMessageIdSeqForTests(): void {
  _msgIdSeq = 0;
}
