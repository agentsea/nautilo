import { and, eq, inArray, messageReactions } from "@nautilo/db";
import { withAgentTrustContext } from "./trust-agent-db";
import { emitAgentEvent } from "../runtime-hooks";

export interface ReactionAggregate {
  emoji: string;
  count: number;
  /** Up to 25 actor IDs; truncated beyond that — `count` remains exact. */
  actorIds: string[];
  /** Truncation flag so the client knows to fetch the full list on hover. */
  truncated: boolean;
}

interface TrustCtx {
  userId: string;
  agentId?: string | null;
}

const ACTOR_CAP = 25;

/**
 * Pure aggregation of flat reaction rows into per-message aggregates. Exported
 * for unit testing (no DB). Rows are expected pre-sorted by (messageId, emoji,
 * createdAt) but correctness does not depend on the order.
 */
export function aggregateReactionRows(
  rows: { messageId: number; emoji: string; actorId: string }[],
): Map<number, ReactionAggregate[]> {
  const result = new Map<number, ReactionAggregate[]>();
  const byMsg = new Map<number, Map<string, ReactionAggregate>>();
  for (const row of rows) {
    let emojiMap = byMsg.get(row.messageId);
    if (!emojiMap) {
      emojiMap = new Map();
      byMsg.set(row.messageId, emojiMap);
    }
    let agg = emojiMap.get(row.emoji);
    if (!agg) {
      agg = { emoji: row.emoji, count: 0, actorIds: [], truncated: false };
      emojiMap.set(row.emoji, agg);
    }
    agg.count += 1;
    if (agg.actorIds.length < ACTOR_CAP) {
      agg.actorIds.push(row.actorId);
    } else {
      agg.truncated = true;
    }
  }
  for (const [messageId, emojiMap] of byMsg) {
    result.set(messageId, Array.from(emojiMap.values()));
  }
  return result;
}

/** Batch read for GET /api/rooms/:id/messages inlining AND conductor transcript. */
export async function listReactionsForMessageIds(args: {
  messageIds: number[];
  ctx: TrustCtx;
}): Promise<Map<number, ReactionAggregate[]>> {
  const { messageIds, ctx } = args;
  const ids = messageIds.filter((n) => Number.isFinite(n));
  if (ids.length === 0) return new Map();

  const rows = await withAgentTrustContext(
    { userId: ctx.userId, agentId: ctx.agentId ?? undefined },
    (tx) =>
      tx
        .select({
          messageId: messageReactions.messageId,
          emoji: messageReactions.emoji,
          actorId: messageReactions.actorId,
        })
        .from(messageReactions)
        .where(inArray(messageReactions.messageId, ids))
        .orderBy(
          messageReactions.messageId,
          messageReactions.emoji,
          messageReactions.createdAt,
        ),
  );

  return aggregateReactionRows(rows);
}

/** Single-message read for the dedicated GET route. */
export async function listReactionsForMessage(args: {
  messageId: number;
  ctx: TrustCtx;
}): Promise<ReactionAggregate[]> {
  const map = await listReactionsForMessageIds({
    messageIds: [args.messageId],
    ctx: args.ctx,
  });
  return map.get(args.messageId) ?? [];
}

/**
 * Returns `{ created: true }` if a row was inserted, `false` if it already
 * existed. Emits `reaction.added` on `room:<roomId>` only when `created` is
 * true (MR8). Single emit site for both REST and the agent tool.
 */
export async function addReaction(args: {
  messageId: number;
  actorId: string;
  emoji: string;
  roomId: string;
  ctx: TrustCtx;
}): Promise<{ created: boolean }> {
  const { messageId, actorId, emoji, roomId, ctx } = args;
  const inserted = await withAgentTrustContext(
    { userId: ctx.userId, agentId: ctx.agentId ?? undefined },
    (tx) =>
      tx
        .insert(messageReactions)
        .values({ messageId, actorId, emoji })
        .onConflictDoNothing()
        .returning({ messageId: messageReactions.messageId }),
  );
  const created = inserted.length > 0;
  if (created) {
    emitAgentEvent({
      type: "reaction.added",
      laneKey: `room:${roomId}`,
      messageId,
      actorId,
      emoji,
      createdAt: new Date().toISOString(),
    });
  }
  return { created };
}

/**
 * Returns `{ removed: true }` if a row was deleted, `false` if it didn't
 * exist. Emits `reaction.removed` on `room:<roomId>` only when `removed` is
 * true (MR8).
 */
export async function removeReaction(args: {
  messageId: number;
  actorId: string;
  emoji: string;
  roomId: string;
  ctx: TrustCtx;
}): Promise<{ removed: boolean }> {
  const { messageId, actorId, emoji, roomId, ctx } = args;
  const deleted = await withAgentTrustContext(
    { userId: ctx.userId, agentId: ctx.agentId ?? undefined },
    (tx) =>
      tx
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.actorId, actorId),
            eq(messageReactions.emoji, emoji),
          ),
        )
        .returning({ messageId: messageReactions.messageId }),
  );
  const removed = deleted.length > 0;
  if (removed) {
    emitAgentEvent({
      type: "reaction.removed",
      laneKey: `room:${roomId}`,
      messageId,
      actorId,
      emoji,
    });
  }
  return { removed };
}
