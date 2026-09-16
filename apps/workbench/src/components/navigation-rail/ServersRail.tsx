import { useEffect, useState, type ReactElement } from "react";
import { Server } from "lucide-react";
import {
  desktopAPI,
  type DesktopServerListEntry,
  type DesktopServerListResult,
} from "../../lib/desktop";
import { ServerIcon } from "../server/server-icon";
import { LeftColumnRailToggle } from "./LeftColumnRailToggle";
import type { RailIconState } from "./left-column-nav";
import {
  ServerAttentionBadge,
  aggregateInactiveServerNotifications,
  aggregateServerAttentionPresentation,
} from "../../modes/servers/server-attention";

export interface ServersRailProps {
  state: RailIconState;
  onToggle: () => void;
}

function displayName(server: DesktopServerListEntry | undefined): string {
  if (!server) return "server";
  if (server.name?.trim()) return server.name;
  try {
    return new URL(server.url).host || server.url;
  } catch {
    return server.url;
  }
}

/** The active server is a standard left-column rail control, not a new rail type. */
export function ServersRail({ state, onToggle }: ServersRailProps): ReactElement {
  const [activeServer, setActiveServer] = useState<DesktopServerListEntry | undefined>();
  const [aggregate, setAggregate] = useState<
    DesktopServerListResult["aggregate"]
  >({
    unreadCount: 0,
    importantUnreadCount: 0,
    unavailableServerCount: 0,
  });

  useEffect(() => {
    let current = true;
    const refresh = async () => {
      try {
        const result = await desktopAPI?.servers?.list?.();
        if (current && result) {
          setActiveServer(result.servers.find((server) => server.active));
          setAggregate(aggregateInactiveServerNotifications(result.servers));
        }
      } catch {
        // The panel owns connection error treatment; the rail keeps its fallback icon.
      }
    };
    void refresh();
    const unsubscribe = desktopAPI?.servers?.onChanged?.(() => void refresh());
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, []);

  const name = displayName(activeServer);
  const title = `Switch server — ${name}`;
  const attention = aggregateServerAttentionPresentation(aggregate, "Other servers");

  return (
    <LeftColumnRailToggle
      Icon={Server}
      iconSlot={
        activeServer ? (
          <ServerIcon
            icon={undefined}
            imageUrl={activeServer.iconUrl}
            size={16}
            fallbackInitial={name}
            framed={false}
            className="h-4 w-4"
          />
        ) : undefined
      }
      state={state}
      onActivate={onToggle}
      ariaLabel={attention ? `${title}. ${attention.ariaLabel}` : title}
      titles={{ open: title, collapsed: title, inactive: title }}
      testId="servers-rail-toggle"
      dataUnread={attention?.hasUnread}
      badge={
        attention?.hasUnread && state !== "open" ? (
          <span className="absolute right-0 top-0 -translate-y-1/4 translate-x-1/4 ring-2 ring-background-panel">
            <ServerAttentionBadge
              attention={attention}
              testId="servers-rail-attention"
            />
          </span>
        ) : undefined
      }
    />
  );
}
