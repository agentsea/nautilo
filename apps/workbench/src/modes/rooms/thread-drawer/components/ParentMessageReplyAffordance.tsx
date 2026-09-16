import { useState } from "react";
import { useOpenThread } from "../use-open-thread";
import { useNotificationState } from "../../../../notifications/notification-state-context";
import { subthreadAnchorKey } from "../../../../notifications/notification-display";

export interface ParentMessageReplyAffordanceProps {
  parentRoomId: string | null;
  messageId: number;
  replyCount: number;
}

export function ParentMessageReplyAffordance({
  parentRoomId,
  messageId,
  replyCount,
}: ParentMessageReplyAffordanceProps) {
  const openThread = useOpenThread();
  const [openError, setOpenError] = useState<"not_visible" | "failed" | null>(
    null,
  );
  const notifications = useNotificationState();
  const attention = parentRoomId
    ? notifications.subthreadsByAnchor.get(
        subthreadAnchorKey(parentRoomId, messageId),
      )
    : undefined;

  if (!parentRoomId || replyCount === 0) return null;
  const segments = [
    `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`,
    attention && attention.unreadCount > 0
      ? `${attention.unreadCount} unread`
      : null,
    attention && attention.importantUnreadCount > 0
      ? `${attention.importantUnreadCount} important`
      : null,
  ].filter((segment): segment is string => segment !== null);

  return (
    <>
      <button
        type="button"
        aria-label={`Open ${replyCount} replies in thread`}
        onClick={(event) => {
          event.stopPropagation();
          setOpenError(null);
          void openThread(parentRoomId, messageId).then((result) => {
            if (!result.opened) setOpenError(result.reason);
          });
        }}
        className="ml-2 inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-foreground-muted hover:bg-[var(--primary-muted)]"
      >
        {segments.join(" · ")}
      </button>
      {openError ? (
        <span role="alert" className="ml-2 text-[11px] text-red-500">
          {openError === "not_visible"
            ? "This thread isn't available to you."
            : "Couldn't open thread. Try again."}
        </span>
      ) : null}
    </>
  );
}
