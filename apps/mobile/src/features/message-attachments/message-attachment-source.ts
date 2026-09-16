import type { MessageAttachmentPreview } from "@/lib/messages";

export type RetainedMessageAttachment = Extract<MessageAttachmentPreview, { kind: "retained" }>;

export type MessageAttachmentScope = Readonly<{
  serverId: string;
  serverUrl: string;
  accountId: string;
  roomId: string;
  messageId: string;
  attachmentId: string;
  generation: number;
}>;

export function sameMessageAttachmentScope(left: MessageAttachmentScope, right: MessageAttachmentScope | null): boolean {
  return right !== null && Object.keys(left).every((key) => left[key as keyof MessageAttachmentScope] === right[key as keyof MessageAttachmentScope]);
}

export function isRetainedAttachment(value: MessageAttachmentPreview): value is RetainedMessageAttachment {
  return value.kind === "retained";
}

export function isCurrentMessageAttachmentSelection(
  items: readonly { kind: string; id?: string; attachments?: readonly MessageAttachmentPreview[] }[],
  selection: Readonly<{ messageId: string; attachmentId: string }>,
): boolean {
  return items.some((item) => item.kind === "message" && item.id === selection.messageId &&
    item.attachments?.some((attachment) => attachment.kind === "retained" && attachment.attachmentId === selection.attachmentId));
}
