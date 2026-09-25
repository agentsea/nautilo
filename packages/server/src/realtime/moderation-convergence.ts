import {
  actors, and, eq, isNull, moderationAccessAllowedSql,
  moderationActions, moderationSubjects, or, roomMembers, rooms, sql,
} from "@nautilo/db";
import { getServerDirectDb } from "../lib/server-direct-db";
import type { InMemoryRelayRegistry, JobManager } from "@nautilo/runtime";
import type { RelaySocketLifecycleController } from "./relay-endpoint";
import {
  disconnectHumanWebSockets, publishDomainKeyCatchUpRequested, publishRoomCatalogChanged,
  refreshRoomSubscriptionsForUser, removeHumanRoomSubscriptions,
} from "./ws-publisher";

/** Reconcile local clients and work from current authority, including action retries.
 * Cross-process, originating-Room and audit recovery must also complete before
 * the moderation coordinator's full checkpoint is advanced.
 */
type ModerationConvergenceDeps = Readonly<{
  relayRegistry: Pick<InMemoryRelayRegistry, "snapshotForUser" | "unregister">;
  relaySockets: RelaySocketLifecycleController;
  work: Pick<JobManager, "reconcileInvocationAccess">;
}>;

export async function convergeModerationRealtime(operationId: string, deps: ModerationConvergenceDeps): Promise<void> {
  const db = getServerDirectDb();
  const [action] = await db.select({ roomId: moderationActions.roomId, userId: moderationSubjects.userId,
    action: moderationActions.action }).from(moderationActions)
    .innerJoin(moderationSubjects, eq(moderationSubjects.id, moderationActions.subjectId))
    .where(eq(moderationActions.operationId, operationId));
  if (!action) throw new Error("Moderation action unavailable");
  if (action.userId === null) throw new Error("Erased moderation subject requires account-erasure convergence");
  // A pending Task save must not delay socket withdrawal, and a failed
  // realtime projection must not shelter the Human's executable work.
  const effects = await Promise.allSettled([
    deps.work.reconcileInvocationAccess(action.userId),
    convergeLocalClients({ ...action, userId: action.userId }, deps),
  ]);
  for (const effect of effects) if (effect.status === "rejected") throw effect.reason;
}

async function convergeLocalClients(
  action: { userId: string; roomId: string | null; action: string },
  deps: ModerationConvergenceDeps,
): Promise<void> {
  const db = getServerDirectDb();
  const userId = action.userId;
  const [subject] = await db.select({ actorId: actors.id,
    admitted: moderationAccessAllowedSql(sql`${actors.ownerId}`) }).from(actors)
    .where(and(eq(actors.ownerId, userId), eq(actors.kind, "user")));
  if (!subject) throw new Error("Moderation subject Actor unavailable");

  if (!subject.admitted) {
    disconnectHumanWebSockets(userId);
    const relayIds = deps.relayRegistry.snapshotForUser(userId).map(relay => relay.relayId);
    deps.relaySockets.closeRelays(relayIds);
    // Invalidate dispatch authority now, rather than waiting for the peer's
    // close handshake. The endpoint retains its ordinary resource cleanup.
    await Promise.all(relayIds.map(id => deps.relayRegistry.unregister(id)));
  } else {
    if (action.roomId !== null) {
      const deniedRooms = await db.select({ id: rooms.id }).from(rooms)
        .where(and(or(eq(rooms.id, action.roomId), eq(rooms.parentRoomId, action.roomId)),
          sql`NOT EXISTS (SELECT 1 FROM room_members member WHERE member.room_id = ${rooms.id}
            AND member.actor_id = ${subject.actorId}::uuid)`));
      removeHumanRoomSubscriptions(userId, new Set(deniedRooms.map(room => room.id)));
    }
    await refreshRoomSubscriptionsForUser(userId, subject.actorId);
    publishRoomCatalogChanged(userId);
  }

  if (action.action !== "ban" && action.action !== "kick") return;
  // Server removal retains the canonical graph, which identifies every
  // affected Namespace. Room removal uses the retained action scope instead.
  const affected = await db.select({ roomId: rooms.id, namespaceId: rooms.namespaceId }).from(rooms)
    .where(and(isNull(rooms.parentRoomId), isNull(rooms.archivedAt),
      action.roomId === null
        ? sql`EXISTS (SELECT 1 FROM room_members member WHERE member.room_id = ${rooms.id}
            AND member.actor_id = ${subject.actorId}::uuid)`
        : or(eq(rooms.id, action.roomId), sql`${rooms.id} = (SELECT parent_room_id FROM rooms WHERE id = ${action.roomId}::uuid)`)));
  for (const coordinate of affected) {
    if (coordinate.namespaceId === null) continue;
    const recipients = await db.select({ userId: actors.ownerId }).from(roomMembers)
      .innerJoin(actors, and(eq(actors.id, roomMembers.actorId), eq(actors.kind, "user")))
      .where(and(eq(roomMembers.roomId, coordinate.roomId),
        moderationAccessAllowedSql(sql`${actors.ownerId}`, sql`${roomMembers.roomId}`)));
    const recipientUserIds = recipients.flatMap(recipient => recipient.userId === null ? [] : [recipient.userId]);
    for (const keyClass of ["human", "ai"] as const) {
      publishDomainKeyCatchUpRequested({ ...coordinate, namespaceId: coordinate.namespaceId, keyClass, recipientUserIds });
    }
  }
}
