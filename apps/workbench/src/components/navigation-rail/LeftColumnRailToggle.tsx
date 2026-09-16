/**
 * Shared 3-state left-column rail toggle (D303).
 *
 * Used by RoomRail (chat / rooms explorer) and ArtifactsRail (Boxes). Pure
 * presentation; the 3-state comes from `left-column-nav`:
 *   - open      → full highlight (bg tint + accent bar)
 *   - collapsed → a `›` "click to expand" chevron badge (NOT the full highlight)
 *   - inactive  → plain muted icon
 */

import type { ComponentType, ReactElement, ReactNode, SVGProps } from "react";
import type { RailIconState } from "./left-column-nav";

export interface LeftColumnRailToggleProps {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Replaces the SVG while retaining this control's standard 16×16 icon slot. */
  iconSlot?: ReactNode;
  state: RailIconState;
  onActivate: () => void;
  ariaLabel: string;
  /** Tooltip per state. */
  titles: { open: string; collapsed: string; inactive: string };
  testId: string;
  /** M158 — aggregate unread hint on the rail button (RoomRail only). */
  dataUnread?: boolean;
  /** Optional extra overlay (e.g. RoomRail's unread dot). */
  badge?: ReactNode;
}

export function LeftColumnRailToggle({
  Icon,
  iconSlot,
  state,
  onActivate,
  ariaLabel,
  titles,
  testId,
  dataUnread,
  badge,
}: LeftColumnRailToggleProps): ReactElement {
  const open = state === "open";
  const collapsed = state === "collapsed";
  const title = open ? titles.open : collapsed ? titles.collapsed : titles.inactive;

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={open ? "true" : "false"}
      title={title}
      data-active={open || undefined}
      data-collapsed={collapsed || undefined}
      data-unread={dataUnread || undefined}
      data-testid={testId}
      onClick={onActivate}
      className={[
        "relative mx-1.5 flex h-9 items-center justify-center rounded-md transition-colors",
        open
          ? "bg-[var(--primary-muted)] text-foreground"
          : "text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground",
      ].join(" ")}
    >
      {open ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-sm bg-accent"
        />
      ) : null}
      {iconSlot ?? <Icon aria-hidden="true" className="h-4 w-4" />}
      {badge}
    </button>
  );
}
