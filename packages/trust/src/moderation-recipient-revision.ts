import { and, asc, eq, sql, actors, roomMembers, rooms, type InviteSeedTx } from "@nautilo/db";

/** Admission changes the effective audience without deleting canonical membership. */
export async function advanceModerationRecipientRevisionsInTx(tx: InviteSeedTx, userId: string): Promise<void> {
  // Match the existing parent-before-child lock order used by crypto and
  // membership publication. The Namespace owner and inherited children remain
  // the same identities; their current authority revision fences old plans.
  const affected = await tx.select({ id: rooms.id }).from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .innerJoin(actors, and(eq(actors.id, roomMembers.actorId), eq(actors.kind, "user"), eq(actors.ownerId, userId)))
    .orderBy(sql`${rooms.parentRoomId} NULLS FIRST`, asc(rooms.id)).for("update", { of: rooms });
  if (affected.length === 0) return;
  await tx.update(rooms).set({ namespaceAccessRevision: sql`${rooms.namespaceAccessRevision} + 1` })
    .where(sql`${rooms.id} = ANY(${sql.param(affected.map(room => room.id))}::uuid[])`);
}
