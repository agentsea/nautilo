/**
 * Panel edge strip (D077 accordion).
 *
 * Rendered only when the corresponding panel is collapsed. Thin seam
 * at the screen edge that expands on hover to reveal a chevron pointing
 * toward where the panel will appear. Click anywhere on the strip →
 * panel expands to its pre-collapse width.
 *
 * Replaces the previous header-icon toggles (`▤` / `ⓘ`) which overloaded
 * glyphs that universally mean other things ("tree view" / "get info").
 * The collapse affordance now lives at the collapsed panel's own
 * location, which is how every other app does accordion chrome.
 *
 * Visual model — two states:
 *   - idle:  6px wide seam, subtle border-colored line, no chevron
 *   - hover: 24px wide, chevron centered, primary/15 background
 *
 * Positioning: absolute against the shell's grid container (parent sets
 * `position: relative`). We sit at the extreme screen edge rather than
 * at the formerly-occupied column boundary so the restore target is
 * always predictable — "click the edge of the window to bring it back."
 */

import { useState } from "react";
import type { UsePanelSizes } from "./use-panel-sizes";

const IDLE_WIDTH_PX = 6;
const HOVER_WIDTH_PX = 24;

interface Props {
  kind: "browser" | "context";
  sizes: UsePanelSizes;
  label?: string;
  /**
   * Override the collapsed gate. When provided, the strip shows iff this is
   * true (instead of reading `sizes.*Collapsed`). Used by the group-room
   * Members panel whose hidden state lives in `useMembersPanelView`, not the
   * shared panel-sizes flag.
   */
  forceCollapsed?: boolean;
  /**
   * Override the restore action. When provided, clicking the strip calls this
   * instead of `sizes.setCollapsed(kind, false)` — lets the Members ladder
   * restore to its last non-hidden state (rail or full).
   */
  onExpand?: () => void;
}

export function PanelEdgeStrip({
  kind,
  sizes,
  label: labelOverride,
  forceCollapsed,
  onExpand,
}: Props) {
  const [hovered, setHovered] = useState(false);

  const collapsed =
    forceCollapsed ??
    (kind === "browser" ? sizes.browserCollapsed : sizes.contextCollapsed);
  if (!collapsed) return null;

  // Browser strip → left edge, chevron points right (›).
  // Context strip → right edge, chevron points left (‹).
  const label =
    labelOverride ??
    (kind === "browser" ? "Show file browser" : "Show context panel");
  const chevron = kind === "browser" ? "›" : "‹";
  const edgeStyle =
    kind === "browser" ? { left: 0 } : { right: 0 };
  const borderStyle: React.CSSProperties =
    kind === "browser"
      ? { borderRight: "1px solid var(--border)" }
      : { borderLeft: "1px solid var(--border)" };

  const width = hovered ? HOVER_WIDTH_PX : IDLE_WIDTH_PX;

  return (
    <button
      type="button"
      onClick={() => (onExpand ? onExpand() : sizes.setCollapsed(kind, false))}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      aria-label={label}
      title={
        kind === "browser"
          ? `${label} (⌘⇧B)`
          : `${label} (⌘⇧I)`
      }
      className="absolute top-0 bottom-0 z-20 flex cursor-pointer items-center justify-center text-foreground-muted outline-none transition-all duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
      style={{
        width: `${width}px`,
        ...edgeStyle,
        ...borderStyle,
        // Idle: use border color so the strip reads as a visible seam,
        // not the same dark gray as the panel background. Hover: shift
        // to primary tint so the affordance becomes obvious.
        backgroundColor: hovered
          ? "color-mix(in srgb, var(--primary) 15%, transparent)"
          : "var(--border)",
      }}
    >
      <span
        aria-hidden="true"
        className="text-base leading-none select-none transition-opacity duration-150 ease-out"
        style={{
          // Only show the chevron when the strip has width to hold it.
          // Below ~12px of container width the character just clips.
          opacity: hovered ? 1 : 0,
        }}
      >
        {chevron}
      </span>
    </button>
  );
}
