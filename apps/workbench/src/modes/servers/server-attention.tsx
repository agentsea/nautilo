import type { ReactElement } from "react";
import type {
  DesktopServerListEntry,
  DesktopServerListResult,
} from "../../lib/desktop";
import { notificationAttentionPresentation } from "../../notifications/notification-display";

export interface ServerAttentionPresentation {
  hasUnread: boolean;
  importantText: string | null;
  ariaLabel: string;
  stale: boolean;
}

function saturatingAdd(left: number, right: number): number {
  return left >= Number.MAX_SAFE_INTEGER - right
    ? Number.MAX_SAFE_INTEGER
    : left + right;
}

/**
 * Change-server attention belongs only to other servers. The active server's
 * unread state is already represented by Rooms and must not make switching
 * servers look actionable.
 */
export function aggregateInactiveServerNotifications(
  servers: readonly DesktopServerListEntry[],
): DesktopServerListResult["aggregate"] {
  let unreadCount = 0;
  let importantUnreadCount = 0;
  let unavailableServerCount = 0;

  for (const server of servers) {
    if (server.active) continue;
    const summary = server.notificationSummary;
    if (summary.state !== "fresh") {
      unavailableServerCount += 1;
      continue;
    }
    unreadCount = saturatingAdd(unreadCount, summary.unreadCount);
    importantUnreadCount = saturatingAdd(
      importantUnreadCount,
      summary.importantUnreadCount,
    );
  }

  return { unreadCount, importantUnreadCount, unavailableServerCount };
}

export function serverAttentionPresentation(
  summary: DesktopServerListEntry["notificationSummary"],
  label: string,
): ServerAttentionPresentation | null {
  if (summary.state === "unknown") return null;
  const presentation = notificationAttentionPresentation({
    unreadCount: summary.unreadCount,
    importantUnreadCount: summary.importantUnreadCount,
    label,
  });
  if (!presentation) return null;
  return {
    ...presentation,
    stale: summary.state === "stale",
    ariaLabel:
      summary.state === "stale"
        ? `Last known — ${presentation.ariaLabel}`
        : presentation.ariaLabel,
  };
}

export function aggregateServerAttentionPresentation(
  aggregate: DesktopServerListResult["aggregate"],
  label = "Servers",
): ServerAttentionPresentation | null {
  const presentation = notificationAttentionPresentation({
    unreadCount: aggregate.unreadCount,
    importantUnreadCount: aggregate.importantUnreadCount,
    label,
  });
  if (!presentation) return null;
  const unavailable =
    aggregate.unavailableServerCount === 0
      ? ""
      : `. ${aggregate.unavailableServerCount} ${
        aggregate.unavailableServerCount === 1 ? "server is" : "servers are"
      } unavailable and excluded`;
  return {
    ...presentation,
    stale: false,
    ariaLabel: `${presentation.ariaLabel}${unavailable}`,
  };
}

export function ServerAttentionBadge({
  attention,
  testId,
}: {
  attention: ServerAttentionPresentation | null;
  testId: string;
}): ReactElement | null {
  if (!attention?.hasUnread) return null;
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-stale={attention.stale || undefined}
      className={[
        "inline-flex shrink-0 items-center justify-center",
        attention.stale ? "opacity-50" : "",
      ].join(" ")}
      title={attention.ariaLabel}
    >
      {attention.importantText ? (
        <span className="min-w-5 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-5 text-white">
          {attention.importantText}
        </span>
      ) : (
        <span className="h-2 w-2 rounded-full bg-accent" />
      )}
    </span>
  );
}
