import { randomUUID } from "node:crypto";
import { acquireRoomWriteLock, getSharedDirectDb, messageDeletionReceipts, type DirectDatabase } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { eventBus } from "@nautilo/runtime";
import {
  deleteMessageHardInTx,
  listHumanUserIdsInRoom,
  type MessageDeleteAuthority,
} from "@nautilo/trust";

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
  actorUserId: string;
  actorId: string | null;
  source: "room_message" | "content_report" | "moderation_ban";
  authority: MessageDeleteAuthority | "report_action" | "server_ban";
  reportId?: string;
  moderationOperationId?: string;
  /** Revalidate trusted scope under the Room lock and, for a protected row,
   * provide its current content-free classification to canonical deletion. */
  verifyInTx?: (tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0]) => Promise<void | {
    subthreadReplyClassification: "counted" | "excluded";
  }>;
  operationId?: string;
  logContext?: string;
}): Promise<void> {
  const context = input.logContext ?? "room message";
  const operationId = input.operationId ?? randomUUID();
  const db = getSharedDirectDb();
  const { wasUnread, orphanedTurnId, rootSummary } = await db.transaction(async (tx) => {
    await acquireRoomWriteLock(tx, input.roomId);
    const structuralProjection = await input.verifyInTx?.(tx);
    return deleteMessageHardInTx(tx, input.messageId, {
      preserveThreadOnModerationDelete: input.source === "moderation_ban",
      ...(structuralProjection ? { protectedStructuralProjection: structuralProjection } : {}),
      afterDeleteEffects: async ({ effects }) => {
        if (effects.roomId !== input.roomId) throw new Error("Message Room changed during deletion");
        await tx.insert(messageDeletionReceipts).values({
          operationId,
          roomId: effects.roomId,
          messageId: input.messageId,
          actorUserId: input.actorUserId,
          actorId: input.actorId,
          source: input.source,
          authority: input.authority,
          reportId: input.reportId ?? null,
          moderationOperationId: input.moderationOperationId ?? null,
          outcome: "deleted",
        });
      },
    });
  });

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
