/**
 * Client-neutral semantic contract for primary message actions.
 *
 * Renderers own interaction/reveal state and bind these IDs to their existing
 * handlers. This module only determines which primary actions are available
 * and their stable order for a Room or subthread message.
 */

export type MessageActionSurface = "room" | "subthread";

export type MessageActionId =
  | "reply"
  | "react"
  | "reply-in-thread"
  | "copy"
  | "report"
  | "edit"
  | "delete";

/** Capability facts supplied by the existing client eligibility checks. */
export interface MessageActionCapabilities {
  readonly reply: boolean;
  readonly react: boolean;
  readonly replyInThread: boolean;
  readonly copy: boolean;
  /** M297 — persisted visible Human or Agent messages, excluding self. */
  readonly report?: boolean;
  readonly edit: boolean;
  readonly delete: boolean;
}

export interface MessageActionDescriptor {
  readonly id: MessageActionId;
  readonly accessibleLabel: string;
  readonly destructive: boolean;
}

export interface MessageActionContractInput {
  readonly surface: MessageActionSurface;
  readonly capabilities: MessageActionCapabilities;
}

const ACTION_DESCRIPTORS: Readonly<Record<MessageActionId, MessageActionDescriptor>> = {
  reply: {
    id: "reply",
    accessibleLabel: "Reply",
    destructive: false,
  },
  react: {
    id: "react",
    accessibleLabel: "React",
    destructive: false,
  },
  "reply-in-thread": {
    id: "reply-in-thread",
    accessibleLabel: "Reply in thread",
    destructive: false,
  },
  copy: {
    id: "copy",
    accessibleLabel: "Copy message",
    destructive: false,
  },
  report: {
    id: "report",
    accessibleLabel: "Report message",
    destructive: false,
  },
  edit: {
    id: "edit",
    accessibleLabel: "Edit message",
    destructive: false,
  },
  delete: {
    id: "delete",
    accessibleLabel: "Delete message",
    destructive: true,
  },
};

const ORDER_BY_SURFACE: Readonly<Record<MessageActionSurface, readonly MessageActionId[]>> = {
  room: ["reply", "react", "reply-in-thread", "copy", "edit", "report", "delete"],
  subthread: ["reply", "react", "copy", "edit", "report", "delete"],
};

function isAvailable(id: MessageActionId, capabilities: MessageActionCapabilities): boolean {
  switch (id) {
    case "reply":
      return capabilities.reply;
    case "react":
      return capabilities.react;
    case "reply-in-thread":
      return capabilities.replyInThread;
    case "copy":
      return capabilities.copy;
    case "report":
      return capabilities.report === true;
    case "edit":
      return capabilities.edit;
    case "delete":
      return capabilities.delete;
  }
}

/**
 * Returns eligible primary actions in their shared Room/subthread order.
 *
 * A subthread never receives `reply-in-thread`, even if its supplied
 * capability is true: nesting a thread inside a subthread is not a supported
 * primary action.
 */
export function getMessageActionDescriptors(
  input: MessageActionContractInput,
): readonly MessageActionDescriptor[] {
  return ORDER_BY_SURFACE[input.surface]
    .filter((id) => isAvailable(id, input.capabilities))
    .map((id) => ACTION_DESCRIPTORS[id]);
}
