import type { ThreadMessageLike } from "@assistant-ui/react";
import type {
  AdvancedVideoWorkcardContinuation,
  MessageArtifactOpenRef,
  MessageAttachmentRef,
} from "@nautilo/types";
import {
  advancedVideoWorkcardSummary,
  dedupeMessageArtifactOpenRefs,
  MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY,
  MESSAGE_ATTACHMENTS_METADATA_KEY,
} from "./session-rehydrate";

export interface CanonicalHumanMessage {
  createdAt?: string;
  messageId: string;
  content: string;
  sourceUserId: string;
  logicalMessageKey?: string;
  editRevision?: number;
  replyToMessageId?: number;
  /** D424 — server-authored open-card pointers; never inferred from text. */
  artifacts?: MessageArtifactOpenRef[];
  /** Server-authored retained message attachments for an ordinary projection. */
  attachments?: MessageAttachmentRef[];
  /** Local receive state only; never put placeholder prose in message content. */
  verificationPending?: boolean;
}

export interface AdvancedVideoWorkcardMessage {
  messageId: string;
  content: string;
  continuation: AdvancedVideoWorkcardContinuation;
}

/**
 * Reconciles the local neutral workcard row with the server's persisted Human
 * input. The raw input is deliberately used only as an exact optimistic key;
 * it never becomes visible transcript prose.
 */
export function reconcileAdvancedVideoWorkcardMessage(
  messages: readonly ThreadMessageLike[],
  message: AdvancedVideoWorkcardMessage,
): readonly ThreadMessageLike[] {
  const compact = {
    id: message.messageId,
    role: "system" as const,
    content: [{ type: "text" as const, text: advancedVideoWorkcardSummary(message.continuation) }],
    metadata: { custom: { workcardContinuation: message.continuation } },
  } as ThreadMessageLike;
  const byId = messages.findIndex((candidate) => String(candidate.id) === message.messageId);
  if (byId >= 0) {
    return messages.map((candidate, index) => index === byId ? compact : candidate);
  }
  const optimistic = messages.findIndex((candidate) => {
    const custom = (candidate.metadata as { custom?: Record<string, unknown> } | undefined)?.custom;
    return custom?.workcardContinuationRequestText === message.content;
  });
  if (optimistic >= 0) {
    return messages.map((candidate, index) => index === optimistic ? compact : candidate);
  }
  return [...messages, compact];
}

function hasValidReplyToMessageId(message: CanonicalHumanMessage): boolean {
  return Number.isInteger(message.replyToMessageId) && message.replyToMessageId! > 0;
}

function artifactOpenRefsEqual(
  current: unknown,
  next: readonly MessageArtifactOpenRef[] | undefined,
): boolean {
  if (next === undefined) return true;
  if (!Array.isArray(current) || current.length !== next.length) return false;
  return current.every((value, index) => {
    const candidate = value as Partial<MessageArtifactOpenRef> | null;
    const expected = next[index];
    return candidate !== null &&
      typeof candidate === "object" &&
      candidate.artifactInternalId === expected?.artifactInternalId &&
      candidate.roomId === expected?.roomId &&
      candidate.basename === expected?.basename &&
      candidate.mimeType === expected?.mimeType &&
      candidate.sizeBytes === expected?.sizeBytes;
  });
}

function dedupeMessageAttachmentRefs(
  attachments: readonly MessageAttachmentRef[] | undefined,
): MessageAttachmentRef[] | undefined {
  if (attachments === undefined) return undefined;
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    if (seen.has(attachment.attachmentId)) return false;
    seen.add(attachment.attachmentId);
    return true;
  });
}

function messageAttachmentRefsEqual(
  current: unknown,
  next: readonly MessageAttachmentRef[] | undefined,
): boolean {
  if (next === undefined) return true;
  if (!Array.isArray(current) || current.length !== next.length) return false;
  return current.every((value, index) => {
    const candidate = value as Partial<MessageAttachmentRef> | null;
    const expected = next[index];
    return candidate !== null &&
      typeof candidate === "object" &&
      candidate.attachmentId === expected?.attachmentId &&
      candidate.filename === expected?.filename &&
      candidate.mimeType === expected?.mimeType &&
      candidate.sizeBytes === expected?.sizeBytes;
  });
}

function canonicalMetadata(
  current: { custom?: Record<string, unknown> } | undefined,
  message: CanonicalHumanMessage,
): { custom: Record<string, unknown> } {
  const artifacts = dedupeMessageArtifactOpenRefs(message.artifacts);
  const attachments = dedupeMessageAttachmentRefs(message.attachments);
  const previousCustom = { ...(current?.custom ?? {}) };
  if (message.verificationPending) {
    delete previousCustom[MESSAGE_ATTACHMENTS_METADATA_KEY];
  } else if (attachments !== undefined) {
    previousCustom[MESSAGE_ATTACHMENTS_METADATA_KEY] = attachments;
  }
  return {
    ...current,
    custom: {
      ...previousCustom,
      sourceUserId: message.sourceUserId,
      ...(message.createdAt ? { sentAt: message.createdAt } : {}),
      ...(message.verificationPending ? { humanMessageVerification: "pending" } : {}),
      ...(message.logicalMessageKey
        ? { logicalMessageKey: message.logicalMessageKey }
        : {}),
      ...(typeof message.editRevision === "number"
        ? { editRevision: message.editRevision }
        : {}),
      ...(hasValidReplyToMessageId(message)
        ? { replyToMessageId: message.replyToMessageId }
        : {}),
      ...(artifacts !== undefined
        ? { [MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY]: artifacts }
        : {}),
    },
  };
}

function messageContainsText(message: ThreadMessageLike, content: string): boolean {
  const custom = (message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom;
  const canonicalContent = content.trim();
  if (
    typeof custom?.optimisticAuthoredText === "string" &&
    custom.optimisticAuthoredText.trim() === canonicalContent
  ) {
    return true;
  }
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) =>
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown; text?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.trim() === canonicalContent,
  );
}

/**
 * Applies a persisted human `message.new` exactly once.
 *
 * A sender's own desktop may have a `user-*` optimistic bubble to reconcile,
 * but another desktop signed in as that same user will not.  The latter still
 * needs the canonical message appended.  `viewerId` is therefore only used to
 * authorize optimistic replacement; it never authorizes dropping a message.
 */
export function reconcileCanonicalHumanMessage(
  messages: readonly ThreadMessageLike[],
  message: CanonicalHumanMessage,
  viewerId: string | null,
): readonly ThreadMessageLike[] {
  if (message.verificationPending) message = { ...message, content: "" };
  const canonicalIndex = messages.findIndex(
    (candidate) => String(candidate.id) === message.messageId,
  );
  if (canonicalIndex >= 0) {
    const current = messages[canonicalIndex];
    if (!current) return messages;
    const metadata = (current.metadata ?? {}) as {
      custom?: Record<string, unknown>;
    };
    const custom = metadata.custom ?? {};
    if (
      message.verificationPending &&
      custom.humanMessageVerification !== undefined &&
      custom[MESSAGE_ATTACHMENTS_METADATA_KEY] === undefined
    ) {
      return messages;
    }
    const artifacts = dedupeMessageArtifactOpenRefs(message.artifacts);
    const attachments = dedupeMessageAttachmentRefs(message.attachments);
    if (
      (!message.verificationPending || custom.humanMessageVerification === "pending") &&
      (!message.verificationPending || custom[MESSAGE_ATTACHMENTS_METADATA_KEY] === undefined) &&
      custom.sourceUserId === message.sourceUserId &&
      (!message.createdAt || custom.sentAt === message.createdAt) &&
      (!message.logicalMessageKey ||
        custom.logicalMessageKey === message.logicalMessageKey) &&
      (typeof message.editRevision !== "number" ||
        custom.editRevision === message.editRevision) &&
      (!hasValidReplyToMessageId(message) ||
        custom.replyToMessageId === message.replyToMessageId) &&
      artifactOpenRefsEqual(
        custom[MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY],
        artifacts,
      ) &&
      messageAttachmentRefsEqual(
        custom[MESSAGE_ATTACHMENTS_METADATA_KEY],
        attachments,
      )
    ) {
      return messages;
    }
    return messages.map((candidate, index) =>
      index === canonicalIndex
        ? ({
            ...candidate,
            ...(message.verificationPending ? { content: [{ type: "text" as const, text: "" }] } : {}),
            metadata: canonicalMetadata(metadata, message),
          } as ThreadMessageLike)
        : candidate,
    );
  }

  const logicalIndex = message.logicalMessageKey
    ? messages.findIndex((candidate) => {
        const metadata = candidate.metadata as
          | { custom?: Record<string, unknown> }
          | undefined;
        return metadata?.custom?.logicalMessageKey === message.logicalMessageKey;
      })
    : -1;

  if (logicalIndex >= 0) {
    const previous = messages[logicalIndex];
    if (!previous) return messages;
    const metadata = (previous.metadata ?? {}) as {
      custom?: Record<string, unknown>;
    };
    return [
      ...messages.slice(0, logicalIndex),
      {
        ...previous,
        id: message.messageId,
        role: "user",
        content: [{ type: "text", text: message.content }],
        metadata: canonicalMetadata(metadata, message),
      } as ThreadMessageLike,
      ...messages.slice(logicalIndex + 1),
    ];
  }

  const optimisticIndex = viewerId === message.sourceUserId
    ? [...messages].reverse().findIndex((candidate) =>
        typeof candidate.id === "string" &&
        candidate.id.startsWith("user-") &&
        messageContainsText(candidate, message.content),
      )
    : -1;

  if (optimisticIndex >= 0) {
    const index = messages.length - 1 - optimisticIndex;
    const previous = messages[index];
    if (!previous) return messages;
    const metadata = (previous.metadata ?? {}) as {
      custom?: Record<string, unknown>;
    };
    return [
      ...messages.slice(0, index),
      {
        ...previous,
        id: message.messageId,
        metadata: canonicalMetadata(metadata, message),
      } as ThreadMessageLike,
      ...messages.slice(index + 1),
    ];
  }

  return [
    ...messages,
    {
      id: message.messageId,
      role: "user",
      content: [{ type: "text", text: message.content }],
      metadata: canonicalMetadata(undefined, message),
    },
  ];
}

/** Settle the existing bubble, without appending late results to another Room. */
export function settleHumanMessageVerification(
  messages: readonly ThreadMessageLike[],
  messageId: string,
  result: { status: "verified"; content: string } | { status: "failed" },
): readonly ThreadMessageLike[] {
  const index = messages.findIndex((message) => String(message.id) === messageId);
  const current = messages[index];
  if (!current) return messages;
  const custom = current.metadata?.custom ?? {};
  // A delayed/duplicate failure must not replace content already verified.
  if (result.status === "failed" && custom.humanMessageVerification !== "pending") {
    return messages;
  }
  const {
    [MESSAGE_ATTACHMENTS_METADATA_KEY]: _ordinaryAttachments,
    ...protectedCustom
  } = custom;
  return messages.map((message, i) => i === index ? {
    ...message,
    content: [{ type: "text", text: result.status === "verified" ? result.content : "" }],
    metadata: {
      ...message.metadata,
      custom: { ...protectedCustom, humanMessageVerification: result.status },
    },
  } as ThreadMessageLike : message);
}
