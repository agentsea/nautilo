import type { ComponentType } from "react";
import { Copy, MessageSquare, Pencil, Reply, Trash2 } from "lucide-react";

export interface MessageActionItem {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface BuildMessageActionsArgs {
  onOpenThread?: () => void;
  reply?: { enabled: boolean; onReply: () => void };
  /** D367 — copy the message's full text to the local clipboard. */
  onCopy?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export function buildMessageActions(args: BuildMessageActionsArgs): MessageActionItem[] {
  const items: MessageActionItem[] = [];

  if (args.onOpenThread) {
    items.push({
      id: "open-thread",
      label: "Open in thread",
      icon: MessageSquare,
      onSelect: args.onOpenThread,
    });
  }

  if (args.reply) {
    items.push({
      id: "reply",
      label: "Reply",
      icon: Reply,
      onSelect: args.reply.onReply,
      disabled: !args.reply.enabled,
    });
  }

  if (args.onCopy) {
    items.push({
      id: "copy",
      label: "Copy message",
      icon: Copy,
      onSelect: args.onCopy,
    });
  }

  if (args.onEdit) {
    items.push({
      id: "edit",
      label: "Edit message",
      icon: Pencil,
      onSelect: args.onEdit,
    });
  }

  if (args.onDelete) {
    items.push({
      id: "delete",
      label: "Delete message",
      icon: Trash2,
      onSelect: args.onDelete,
      danger: true,
    });
  }

  return items;
}
