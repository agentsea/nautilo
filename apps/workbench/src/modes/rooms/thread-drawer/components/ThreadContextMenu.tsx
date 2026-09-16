import { useEffect, useRef } from "react";
import { useOpenThread } from "../use-open-thread";
import { buildMessageActions } from "../../../../components/message-actions/message-actions";

export interface ReplyPreviewPayload {
  senderName: string;
  snippet: string;
}

export interface ThreadContextMenuProps {
  parentRoomId: string | null;
  messageId: number;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  /** A subthread has no nested-thread action. */
  surface?: "room" | "subthread";
  replyPreview?: ReplyPreviewPayload;
  /** When set with `replyPreview`, enables quote-reply (D124 P7). */
  onReply?: () => void;
  /** D367 — copy the message's full text to the local clipboard. */
  onCopy?: () => void;
  /** Edit remains available from the secondary menu as well as the primary rail. */
  onEdit?: () => void;
  block?: { blocked: boolean; onToggle: () => void };
  onDelete?: () => void;
}

export function ThreadContextMenu({
  messageId,
  parentRoomId,
  anchorX,
  anchorY,
  onClose,
  surface = "room",
  replyPreview,
  onReply,
  onCopy,
  onEdit,
  block,
  onDelete,
}: ThreadContextMenuProps) {
  const openThread = useOpenThread();
  const menuRef = useRef<HTMLDivElement>(null);
  const replyEnabled = Boolean(replyPreview && onReply);
  const actions = buildMessageActions({
    ...(surface === "room" && parentRoomId
      ? { onOpenThread: () => void openThread(parentRoomId, messageId) }
      : {}),
    ...(replyPreview || onReply
      ? { reply: { enabled: replyEnabled, onReply: () => onReply?.() } }
      : {}),
    ...(onCopy ? { onCopy } : {}),
    ...(onEdit ? { onEdit } : {}),
    ...(block ? { block } : {}),
    ...(onDelete ? { onDelete } : {}),
  });

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Message actions"
      className="fixed z-50 min-w-[160px] rounded border border-border bg-background shadow-lg"
      style={{ left: anchorX, top: anchorY }}
    >
      {actions.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={
              item.disabled
                ? "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground-muted"
                : item.danger
                  ? "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-red-500 focus:text-red-500 active:text-red-500"
                  : "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-[var(--primary-muted)]"
            }
            title={item.id === "reply" && item.disabled ? "Reply isn't available here" : undefined}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            {Icon ? <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 stroke-[1.75]" /> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
