import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ThreadSummaryChangedEvent } from "@nautilo/types";

type ThreadSummaryMetadata = {
  replyCount?: number;
  lastReplyAt?: string | null;
  summaryRevision?: number;
};

/**
 * Assistant UI only supports this fixed metadata envelope. Build a fresh one
 * instead of spreading an older runtime object's arbitrary top-level fields:
 * that removes the now-legacy D426 top-level summary keys while retaining
 * every supported Assistant UI metadata value.
 */
function supportedMetadata(message: ThreadMessageLike): NonNullable<ThreadMessageLike["metadata"]> {
  const metadata = message.metadata;
  return {
    ...(metadata?.unstable_state !== undefined ? { unstable_state: metadata.unstable_state } : {}),
    ...(metadata?.unstable_annotations !== undefined
      ? { unstable_annotations: metadata.unstable_annotations }
      : {}),
    ...(metadata?.unstable_data !== undefined ? { unstable_data: metadata.unstable_data } : {}),
    ...(metadata?.steps !== undefined ? { steps: metadata.steps } : {}),
    ...(metadata?.timing !== undefined ? { timing: metadata.timing } : {}),
    ...(metadata?.submittedFeedback !== undefined
      ? { submittedFeedback: metadata.submittedFeedback }
      : {}),
    ...(metadata?.isOptimistic !== undefined ? { isOptimistic: metadata.isOptimistic } : {}),
  };
}

function currentRevision(message: ThreadMessageLike): number {
  const revision = (message.metadata?.custom as ThreadSummaryMetadata | undefined)
    ?.summaryRevision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : -1;
}

/**
 * Applies the server's authoritative child-thread summary snapshot to its
 * parent-room anchor. The event is revisioned rather than delta-based, so
 * replayed or stale frames must preserve the existing list identity.
 */
export function applyThreadSummarySnapshot(
  messages: ThreadMessageLike[],
  event: ThreadSummaryChangedEvent,
): ThreadMessageLike[] {
  const anchorIndex = messages.findIndex(
    (message) => String(message.id) === String(event.anchorMessageId),
  );
  if (anchorIndex < 0) return messages;

  const anchor = messages[anchorIndex];
  if (event.summaryRevision <= currentRevision(anchor)) return messages;

  const custom = (anchor.metadata?.custom ?? {}) as ThreadSummaryMetadata;
  return [
    ...messages.slice(0, anchorIndex),
    {
      ...anchor,
      metadata: {
        ...supportedMetadata(anchor),
        custom: {
          ...custom,
          replyCount: event.replyCount,
          lastReplyAt: event.lastReplyAt,
          summaryRevision: event.summaryRevision,
        },
      },
    },
    ...messages.slice(anchorIndex + 1),
  ];
}
