import { randomUUID } from "node:crypto";
import {
  and, asc, eq, inArray, isNull, sql,
  actors, users, rooms, roomMembers,
  privateNamespaceBoundarySql,
  type InviteSeedTx,
} from "@nautilo/db";
import { insertPrivateRoomBundleTx } from "./queries";

export interface ImmutableContentAccessAudience {
  readonly requesterUserId: string;
  readonly requesterActorId: string;
  readonly humanActorIds: readonly string[];
}

/**
 * Persistence primitive, not authorization. The caller must authorize the
 * object/operation and fence its policy and invoking audience on this same
 * transaction before resolving any destination. Preparation never calls this.
 *
 * Unlike the legacy conversational lookup, only an immutable access Room can
 * satisfy a person grant. All grants using this primitive serialize by the
 * normalized audience, irrespective of sender, object kind or target order.
 * The caller owns commit/rollback, including the subsequent attachment write.
 */
export async function resolveContentAccessNamespaceInTx(
  tx: InviteSeedTx,
  input: ImmutableContentAccessAudience,
): Promise<{ roomId: string; namespaceId: string; minted: boolean }> {
  const audience = [...new Set(input.humanActorIds)].sort();
  if (!audience.length || !audience.includes(input.requesterActorId)) {
    throw new Error("Content access audience must contain its requester");
  }
  const lockKey = `content-access:human-set:${JSON.stringify(audience)}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  // Lock identities through publication. A disabled or nonlocal target is
  // never admitted merely because an old Room still contains its actor ID.
  const humans = await tx.select({ actorId: actors.id, userId: users.id })
    .from(actors).innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(inArray(actors.id, audience), eq(actors.kind, "user"),
      isNull(users.disabledAt), isNull(users.server)))
    .orderBy(asc(actors.id)).for("share");
  if (humans.length !== audience.length || !humans.some((human) =>
    human.actorId === input.requesterActorId && human.userId === input.requesterUserId)) {
    throw new Error("Content access audience is no longer available");
  }

  // Historical duplicates are preserved. Select one deterministically, and
  // verify canonical membership rather than trusting only its denormalization.
  // Opaque historical thread keys are deliberately not interpreted here.
  const [candidate] = await tx.select({ roomId: rooms.id, namespaceId: rooms.namespaceId })
    .from(rooms).where(and(eq(rooms.kind, "access"),
      eq(rooms.humanActorIds, audience),
      privateNamespaceBoundarySql(rooms.namespaceId)))
    .orderBy(asc(rooms.createdAt), asc(rooms.id)).limit(1);
  if (candidate) {
    const members = await tx.select({ actorId: roomMembers.actorId })
      .from(roomMembers).where(eq(roomMembers.roomId, candidate.roomId))
      .orderBy(asc(roomMembers.actorId));
    if (members.length === audience.length && members.every((member, i) => member.actorId === audience[i])) {
      return { ...candidate, minted: false };
    }
    // A corrupt membership projection is not permission to mint another
    // authority container or silently select a different audience.
    throw new Error("Content access Room membership is inconsistent");
  }

  const roomId = randomUUID();
  const { namespaceId } = await insertPrivateRoomBundleTx(tx, {
    roomId,
    ownerUserId: input.requesterUserId,
    createdByActorId: input.requesterActorId,
    label: "Shared access",
    graphThreadId: `access:${roomId}`,
    humanActorIds: audience,
    roomKind: "access",
    roomType: "shared",
    memberRows: audience.map((actorId) => ({ actorId,
      roomRole: actorId === input.requesterActorId ? "admin" : "member" })),
  });
  return { roomId, namespaceId, minted: true };
}
