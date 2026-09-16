/**
 * Room rail toggle (D182 Phase 11.6.B).
 *
 * Single Slack-style icon button mounted in the navigation rail
 * between the primary destinations (Home / Open folder / Settings)
 * and the utility / identity footer.
 *
 * Click TOGGLES the browser column's mode between its default
 * Artifacts/Files content and the Rooms-explorer view (with grouped
 * People / Agents / Groups / Recent / Agent-to-Agent sections per
 * `<RelationshipExplorer />`). The browser column hosts mode-tabs
 * (Artifacts / Files / Rooms);
 * the rail icon is the entry point to "Rooms" mode. This is NOT a
 * popover — the explorer takes the full browser column so the user
 * can see grouped sections + last-message previews + search without
 * a cramped overlay.
 *
 * The original D111 P3 implementation (commit c81c5f6e) shipped
 * this swap as a permanent hijack triggered by `auth.viewer.isVerified`,
 * eliminating Files / Artifacts access for any verified user.
 * D182 corrects that: it keeps the explorer-style grouping but
 * makes the swap a USER-CONTROLLED TOGGLE so the same column hosts
 * Artifacts/Files by default and Rooms-explorer on demand.
 *
 * **Attention indicator** (M238) — authoritative active-server totals drive a
 * dot for ambient unread; important unread replaces that dot with a compact count.
 */

import type { ReactElement } from "react";
import { MessageSquare } from "lucide-react";
import { useRoomNavigation } from "../../contexts/room-navigation-context";
import { useNotificationState } from "../../notifications/notification-state-context";
import { notificationAttentionPresentation } from "../../notifications/notification-display";
import { LeftColumnRailToggle } from "./LeftColumnRailToggle";
import type { RailIconState } from "./left-column-nav";

export interface RoomRailProps {
  /** 3-state from `roomsIconState`: open (explorer showing) / collapsed
   *  (rooms is the mode but hidden → `›` expand hint) / inactive. */
  state: RailIconState;
  /** Click handler — the shell applies the rooms toggle intent. */
  onToggle: () => void;
}

export function RoomRail({ state, onToggle }: RoomRailProps): ReactElement | null {
  const roomNav = useRoomNavigation();
  const notifications = useNotificationState();

  // Render no rail entry pre-load. The chat surface owns its own
  // empty-state affordances; mounting a phantom rooms button while
  // status === "loading" just adds visual noise.
  if (roomNav.status !== "ready") return null;

  const totals = notifications.snapshot?.totals;
  const attention = totals
    ? notificationAttentionPresentation({
        ...totals,
        label: "Rooms",
      })
    : null;
  const hasUnread = attention?.hasUnread ?? false;

  return (
    <LeftColumnRailToggle
      Icon={MessageSquare}
      state={state}
      onActivate={onToggle}
      ariaLabel={
        attention
          ? `${attention.ariaLabel}. Open relationship explorer`
          : "Rooms — open relationship explorer"
      }
      titles={{
        open: "Rooms explorer (open)",
        collapsed: "Show rooms explorer",
        inactive: "Open rooms explorer",
      }}
      testId="room-rail-toggle"
      dataUnread={hasUnread}
      badge={
        hasUnread ? (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 flex -translate-y-1/4 translate-x-1/4 items-center gap-0.5"
          >
            {!attention?.importantText ? (
              <span
                data-testid="room-rail-unread-dot"
                className="h-2 w-2 rounded-full bg-accent ring-2 ring-background-panel"
              />
            ) : null}
            {attention?.importantText ? (
              <span
                data-testid="room-rail-important-count"
                className="min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-4 text-white ring-2 ring-background-panel"
              >
                {attention.importantText}
              </span>
            ) : null}
          </span>
        ) : undefined
      }
    />
  );
}
