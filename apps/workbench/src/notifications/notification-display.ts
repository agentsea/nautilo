import type {
  NotificationLevel,
  NotificationStateResponse,
} from "@nautilo/types";

const NOTIFICATION_COMPACT_COUNT_MAX = 99;

function isValidNotificationCount(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

export function formatCompactNotificationCount(value: number): string | null {
  if (!isValidNotificationCount(value)) return null;
  return value > NOTIFICATION_COMPACT_COUNT_MAX
    ? `${NOTIFICATION_COMPACT_COUNT_MAX}+`
    : String(value);
}

export interface NotificationAttentionPresentation {
  hasUnread: boolean;
  importantText: string | null;
  ariaLabel: string;
}

export function notificationAttentionPresentation(input: {
  unreadCount: number;
  importantUnreadCount: number;
  label: string;
}): NotificationAttentionPresentation | null {
  const { unreadCount, importantUnreadCount, label } = input;
  if (
    !isValidNotificationCount(unreadCount) ||
    !isValidNotificationCount(importantUnreadCount) ||
    importantUnreadCount > unreadCount
  ) {
    return null;
  }
  const importantText =
    importantUnreadCount > 0
      ? formatCompactNotificationCount(importantUnreadCount)
      : null;
  return {
    hasUnread: unreadCount > 0,
    importantText,
    ariaLabel: `${label}: ${unreadCount} unread ${
      unreadCount === 1 ? "message" : "messages"
    }, ${importantUnreadCount} important ${
      importantUnreadCount === 1 ? "message" : "messages"
    }`,
  };
}

export function notificationLevelLabel(level: NotificationLevel): string {
  switch (level) {
    case "none":
      return "Nothing";
    case "direct":
      return "Directed messages";
    case "all":
      return "All messages";
  }
}

export function subthreadAnchorKey(
  parentRoomId: string,
  anchorMessageId: number,
): string {
  return `${parentRoomId}\u0000${anchorMessageId}`;
}

export function buildSubthreadsByAnchor(
  snapshot: NotificationStateResponse | null,
): ReadonlyMap<string, NotificationStateResponse["subthreads"][number]> {
  return new Map(
    snapshot?.subthreads.map((subthread) => [
      subthreadAnchorKey(
        subthread.parentRoomId,
        subthread.anchorMessageId,
      ),
      subthread,
    ]) ?? [],
  );
}
