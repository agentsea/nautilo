import { warn } from "@nautilo/logger";
import { eventBus } from "@nautilo/runtime";
import { deleteMessageHard, listHumanUserIdsInRoom } from "@nautilo/trust";

import { cleanupRetainedAttachmentsForTurn } from "./attachments";
import {
  publishMessageDeleted,
  recomputeAndPublishNotificationState,
} from "../realtime/ws-publisher";

/**
 * One canonical post-authorization hard-delete path for ordinary and
 * report-driven deletion. Persistence errors remain authoritative; cleanup
 * and realtime convergence stay best-effort as they were in the Room route.
 */
export async function deleteMessageWithConvergence(input: {
  roomId: string;
  messageId: number;
  logContext?: string;
}): Promise<void> {
  const context = input.logContext ?? "room message";
  const { wasUnread, orphanedTurnId, rootSummary } = await deleteMessageHard(
    input.messageId,
  );

  if (orphanedTurnId) {
    await cleanupRetainedAttachmentsForTurn(orphanedTurnId).catch((error) =>
      warn(
        `[${context}] attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  try {
    publishMessageDeleted({ roomId: input.roomId, messageId: input.messageId });
    if (rootSummary) {
      eventBus.emit({
        type: "thread.summary.changed",
        laneKey: `room:${rootSummary.parentRoomId}`,
        anchorMessageId: rootSummary.anchorMessageId,
        replyCount: rootSummary.replyCount,
        lastReplyAt: rootSummary.lastReplyAt?.toISOString() ?? null,
        summaryRevision: rootSummary.revision,
      });
    }
    if (wasUnread) {
      const recipientUserIds = await listHumanUserIdsInRoom(input.roomId);
      await recomputeAndPublishNotificationState({
        roomId: input.roomId,
        recipientUserIds,
      }).catch((error) => {
        warn(
          `[${context}] unread publish failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        );
      });
    }
  } catch (error) {
    warn(
      `[${context}] publish failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
  }
}
