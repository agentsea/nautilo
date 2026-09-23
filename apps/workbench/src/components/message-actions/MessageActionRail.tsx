import type { ReactElement, ReactNode } from "react";
import { Copy, MessageSquare, Pencil, Reply, Trash2 } from "lucide-react";
import {
  type MessageActionDescriptor,
  type MessageActionId,
} from "@nautilo/types";
import { MessageReactTrigger } from "../../modes/rooms/shape/reactions/MessageReactTrigger";

export interface MessageActionRailProps {
  /** Already-authorized action descriptors in shared contract order. */
  readonly descriptors: readonly MessageActionDescriptor[];
  /** The chronological tail stays visible; older rows reveal on hover/focus. */
  readonly alwaysVisible: boolean;
  /** Persistent message metadata that shares the footer ahead of the rail. */
  readonly leading?: ReactNode;
  readonly onReact: (emoji: string) => void;
  readonly onReply: () => void;
  readonly onReplyInThread: () => void;
  readonly onCopy: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

const ICON_BY_ACTION: Readonly<
  Partial<Record<MessageActionId, typeof Reply>>
> = {
  reply: Reply,
  "reply-in-thread": MessageSquare,
  copy: Copy,
  edit: Pencil,
  delete: Trash2,
};

const HANDLER_BY_ACTION = (
  props: MessageActionRailProps,
): Readonly<Partial<Record<Exclude<MessageActionId, "react">, () => void>>> => ({
  reply: props.onReply,
  "reply-in-thread": props.onReplyInThread,
  copy: props.onCopy,
  edit: props.onEdit,
  delete: props.onDelete,
});

/**
 * Fixed-height, bottom-of-message primary action rail.
 *
 * Every rendered message owns this slot from its first render, including
 * optimistic/streaming rows without a numeric server id. Older rails fade in
 * via the parent message's hover/focus state; the reserved height never
 * changes, so TranscriptWindow's measured row geometry remains stable.
 */
export function MessageActionRail(props: MessageActionRailProps): ReactElement {
  const handlers = HANDLER_BY_ACTION(props);
  const revealClass = props.alwaysVisible
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus:pointer-events-auto group-focus:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

  return (
    <div
      data-testid="message-action-rail-slot"
      className="mt-1 flex h-8 items-center gap-1"
    >
      {props.leading}
      <div
        data-testid="message-action-rail"
        className={`inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5 shadow-sm transition-opacity ${revealClass}`}
      >
        {props.descriptors.map((descriptor) => {
          if (descriptor.id === "react") {
            return (
              <MessageReactTrigger
                key={descriptor.id}
                onReact={props.onReact}
                accessibleLabel={descriptor.accessibleLabel}
                title={descriptor.accessibleLabel}
              />
            );
          }
          const Icon = ICON_BY_ACTION[descriptor.id];
          const onClick = handlers[descriptor.id];
          if (!Icon || !onClick) return null;
          return (
            <button
              key={descriptor.id}
              type="button"
              aria-label={descriptor.accessibleLabel}
              title={descriptor.accessibleLabel}
              data-testid={`message-action-rail-${descriptor.id}`}
              onClick={onClick}
              className={
                descriptor.destructive
                  ? `${props.alwaysVisible ? "hidden group-hover:flex group-focus:flex group-focus-within:flex" : "flex"} h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground-muted hover:bg-red-500/10 hover:text-red-500 focus:text-red-500 active:text-red-500`
                  : "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground-muted hover:bg-background-element"
              }
            >
              <Icon aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
