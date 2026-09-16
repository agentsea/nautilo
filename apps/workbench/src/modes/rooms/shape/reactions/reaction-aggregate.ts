/**
 * D212 P2 — pure reaction-count aggregation.
 *
 * Applies a single add (+1) or remove (-1) of one emoji to a message's
 * aggregated `{ emoji, count }[]`. Extracted from the runtime WS handler
 * so the count math is unit-testable independent of React/refs.
 *
 * Count semantics: M121 emits reaction.added / reaction.removed ONLY on
 * a real DB row change (idempotent re-adds / absent-removes don't fire),
 * so a single +1 / -1 per event is correct. Entries that fall to zero
 * are dropped so the strip never renders an empty pill.
 */
import type { ReactionAggregate } from "./ReactionStrip";

export function applyReactionDelta(
  current: readonly ReactionAggregate[],
  emoji: string,
  delta: 1 | -1,
): ReactionAggregate[] {
  const next = current.map((r) => ({ ...r }));
  const hit = next.find((r) => r.emoji === emoji);
  if (hit) {
    hit.count += delta;
  } else if (delta > 0) {
    next.push({ emoji, count: 1 });
  }
  return next.filter((r) => r.count > 0);
}

/**
 * D312 — actor-aware reaction delta. Like `applyReactionDelta`, but keeps the
 * per-emoji `actorIds` in sync AND makes the count change **idempotent per
 * actor**: because counts mirror DISTINCT reactors, our optimistic local
 * toggle and the server's WS echo (which carries the same `actorId`) must
 * collapse to a single +1/-1 rather than double-count.
 *
 * - add (`+1`): no-op if `actorId` already present; else append + count+1
 *   (new emoji → `{ count: 1, actorIds: [actorId] }`).
 * - remove (`-1`): no-op if `actorId` is known-absent; else drop + count-1.
 *   When `actorIds` is unknown (a `truncated` >25-actor aggregate omits it),
 *   fall back to a blind -1 so the count still tracks.
 *
 * Rollback of a failed optimistic toggle is just the inverse call
 * (`applyActorReaction(next, emoji, -delta, actorId)`).
 */
export function applyActorReaction(
  current: readonly ReactionAggregate[],
  emoji: string,
  delta: 1 | -1,
  actorId: string,
): ReactionAggregate[] {
  const next = current.map((r) => ({
    ...r,
    actorIds: r.actorIds ? [...r.actorIds] : undefined,
  }));
  const hit = next.find((r) => r.emoji === emoji);
  if (delta > 0) {
    if (hit) {
      const ids = new Set(hit.actorIds ?? []);
      if (!ids.has(actorId)) {
        ids.add(actorId);
        hit.actorIds = [...ids];
        hit.count += 1;
      }
    } else {
      next.push({ emoji, count: 1, actorIds: [actorId] });
    }
  } else if (hit) {
    const ids = new Set(hit.actorIds ?? []);
    // Idempotent only when the actor list is known; an absent `actorIds`
    // (truncated aggregate) falls back to a blind decrement.
    if (!hit.actorIds || ids.has(actorId)) {
      ids.delete(actorId);
      hit.actorIds = [...ids];
      hit.count -= 1;
    }
  }
  return next.filter((r) => r.count > 0);
}
