/**
 * D212 P3/P5 — read a message's aggregated reactions from
 * `metadata.custom.reactions` and derive which emoji are *newly added*
 * since the previous render, so the strip can animate only the arrivals.
 *
 * First-mount returns an empty animation set: rehydrated history and the
 * initial paint must NOT replay the pop animation for every existing
 * reaction (that would be a confetti storm on room open / scroll-in).
 */
import { useEffect, useMemo, useRef } from "react";
import { useMessage } from "@assistant-ui/react";
import type { ReactionAggregate } from "./ReactionStrip";
import { deriveSelfEmojis } from "./self-emojis";

const EMPTY_REACTIONS: readonly ReactionAggregate[] = Object.freeze([]);
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export function useMessageReactions(myActorId?: string | null): {
  reactions: readonly ReactionAggregate[];
  animatedEmojis: ReadonlySet<string>;
  selfEmojis: ReadonlySet<string>;
} {
  // Selector returns the stored array reference (stable across renders
  // until the runtime replaces it on a reaction delta), or a frozen
  // singleton when absent — both keep useSyncExternalStore happy.
  const reactions = useMessage((s) => {
    const custom = (s.metadata as { custom?: { reactions?: unknown } } | undefined)
      ?.custom;
    const r = custom?.reactions;
    return Array.isArray(r) ? (r as ReactionAggregate[]) : EMPTY_REACTIONS;
  });

  const currentSet = useMemo(
    () => new Set(reactions.map((r) => r.emoji)),
    [reactions],
  );

  const prevRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  const firstRef = useRef(true);

  const animatedEmojis = useMemo<ReadonlySet<string>>(() => {
    if (firstRef.current) return EMPTY_SET;
    const added = new Set<string>();
    for (const emoji of currentSet) {
      if (!prevRef.current.has(emoji)) added.add(emoji);
    }
    return added.size > 0 ? added : EMPTY_SET;
  }, [currentSet]);

  useEffect(() => {
    prevRef.current = currentSet;
    firstRef.current = false;
  }, [currentSet]);

  // D312 — which of these reactions are the viewer's own, for "self"
  // highlighting. Derived from the per-aggregate `actorIds` the server
  // inlines and the runtime keeps in sync on toggle/echo.
  const selfEmojis = useMemo<ReadonlySet<string>>(
    () => deriveSelfEmojis(reactions, myActorId),
    [reactions, myActorId],
  );

  return { reactions, animatedEmojis, selfEmojis };
}
