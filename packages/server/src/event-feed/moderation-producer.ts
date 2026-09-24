import { actors, and, eq, getSharedDirectDb, moderationSubjects } from "@nautilo/db";
import type { EventFeed } from "@nautilo/event-feed";
import { readModerationReceipt, type ModerationEffects } from "@nautilo/trust";

async function resolveIdentities(requesterUserId: string, subjectId: string) {
  const db = getSharedDirectDb();
  const [actor] = await db.select({ id: actors.id }).from(actors)
    .where(and(eq(actors.ownerId, requesterUserId), eq(actors.kind, "user")));
  const [subject] = await db.select({ userId: moderationSubjects.userId }).from(moderationSubjects)
    .where(eq(moderationSubjects.id, subjectId));
  return actor && subject ? { actorId: actor.id, userId: subject.userId } : null;
}

/** A personal receipt, never a Room membership event. Retries cannot widen its
 * audience or duplicate it. Names are resolved at read time; reasons stay out.
 */
export function createModerationEventProducer(deps: {
  feed: Pick<EventFeed, "recordBestEffort">;
  authorize?: typeof readModerationReceipt;
  identities?: typeof resolveIdentities;
}): NonNullable<ModerationEffects["notify"]> {
  return async row => {
    if (!row.requesterUserId || row.roomId !== null
      || (row.action !== "ban" && row.action !== "kick" && row.action !== "lift")) return;
    // Recovery must not deliver new private information to a revoked moderator.
    await (deps.authorize ?? readModerationReceipt)(row.requesterUserId, row.operationId);
    const identities = await (deps.identities ?? resolveIdentities)(row.requesterUserId, row.subjectId);
    if (!identities) return;
    await deps.feed.recordBestEffort({
      key: `moderation:${row.operationId}`, type: "moderation.action",
      actorKind: "human", actorId: identities.actorId,
      recipientUserIds: [row.requesterUserId],
      data: { operationId: row.operationId, action: row.action, userId: identities.userId },
    });
  };
}
