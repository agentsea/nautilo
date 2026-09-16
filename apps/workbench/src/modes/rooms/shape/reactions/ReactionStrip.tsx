/**
 * D212 P3 — per-message reaction strip (presentational).
 *
 * Renders the aggregated emoji + counts that ride under a message
 * bubble. M121 ([nautilo PR #290]) supplies the data: inlined
 * `reactions` on `GET /api/rooms/:id/messages` and live
 * `reaction.added` / `reaction.removed` WS deltas. This component is
 * pure presentation — data plumbing (P1) and WS reconcile (P2) wire it
 * up; toggle-on-click (PUT/DELETE) is a fast-follow.
 *
 * Animation (P5): a pill whose `emoji` is in `animatedEmojis` enters
 * with a playful pop + float/settle. The keyframes live in the global
 * stylesheet under `@media (prefers-reduced-motion: no-preference)` so
 * reduced-motion users get a static strip. Callers pass the set of
 * just-arrived emoji (from the WS handler) so rehydrate/scroll does not
 * replay the animation.
 */
import type { ReactElement } from "react";

/**
 * Client-local aggregate shape. Mirrors the ad-hoc
 * `{ emoji, count }[]` the server inlines today; promote to
 * `@nautilo/types` if a second consumer appears.
 */
export interface ReactionAggregate {
  emoji: string;
  count: number;
  actorIds?: readonly string[];
  truncated?: boolean;
}

export interface ReactionStripProps {
  reactions: readonly ReactionAggregate[] | undefined;
  /** Emoji that just arrived via WS — these animate in (P5). */
  animatedEmojis?: ReadonlySet<string>;
  /** Optional toggle handler (fast-follow; display-only when omitted). */
  onToggle?: (emoji: string) => void;
  /** Emoji the viewer has reacted with — highlighted (fast-follow). */
  selfEmojis?: ReadonlySet<string>;
}

export function ReactionStrip({
  reactions,
  animatedEmojis,
  onToggle,
  selfEmojis,
}: ReactionStripProps): ReactElement | null {
  const visible = (reactions ?? []).filter((r) => r.count > 0);
  if (visible.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="reaction-strip">
      {visible.map((r) => {
        const isSelf = selfEmojis?.has(r.emoji) ?? false;
        const isNew = animatedEmojis?.has(r.emoji) ?? false;
        const interactive = typeof onToggle === "function";
        const base =
          "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none select-none";
        const tone = isSelf
          ? "border-[var(--primary,#3b82f6)]/50 bg-[var(--primary,#3b82f6)]/10 text-foreground"
          : "border-border bg-background-element text-foreground-muted";
        const anim = isNew ? "reaction-pill-pop" : "";
        const cursor = interactive ? "cursor-pointer hover:bg-background-panel" : "";
        return (
          <button
            key={r.emoji}
            type="button"
            disabled={!interactive}
            onClick={interactive ? () => onToggle?.(r.emoji) : undefined}
            className={`${base} ${tone} ${anim} ${cursor}`.trim()}
            aria-label={`${r.emoji} reacted by ${r.count}`}
          >
            <span aria-hidden>{r.emoji}</span>
            {r.count > 1 ? <span className="tabular-nums">{r.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
