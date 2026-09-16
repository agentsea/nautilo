import type { RefObject } from "react";
import { Bell } from "lucide-react";

export function EventFeedBell({
  buttonRef,
  open,
  unreadCount,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  unreadCount: number | null;
  onClick: () => void;
}) {
  const unreadLabel = unreadCount === null
    ? "unread count unavailable"
    : `${unreadCount} unread ${unreadCount === 1 ? "event" : "events"}`;
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={open}
      aria-label={`Events, ${unreadLabel}`}
      title="Events"
      onClick={onClick}
      className="relative shrink-0 rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-interactive"
    >
      <Bell className="h-4 w-4" aria-hidden="true" />
      {unreadCount !== null && unreadCount > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-white"
        >
          {unreadCount}
        </span>
      ) : null}
    </button>
  );
}
