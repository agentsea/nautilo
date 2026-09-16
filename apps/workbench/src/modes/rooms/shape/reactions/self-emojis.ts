/**
 * D312 — derive which emoji the viewer has reacted with.
 *
 * Pure helper: given aggregated reactions (with optional actorIds from
 * the server) and the viewer's actor id, returns the set of emoji to
 * highlight as "self" in ReactionStrip.
 */
export function deriveSelfEmojis(
  reactions: readonly { emoji: string; actorIds?: readonly string[] }[] | undefined,
  myActorId: string | null | undefined,
): ReadonlySet<string> {
  if (!myActorId || !reactions) {
    return new Set();
  }
  const self = new Set<string>();
  for (const r of reactions) {
    if (r.actorIds?.includes(myActorId)) {
      self.add(r.emoji);
    }
  }
  return self;
}
