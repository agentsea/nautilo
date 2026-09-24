import {
  and, eq, inArray, isNotNull, isNull, or, sql,
  createNamespaceBoundaryProjection, moderationEffectiveHumanActorIdsSql,
  rooms,
  type PostgresJsBridgeExecutor,
} from "@nautilo/db";
import { PROTECTED_TOP_LEVEL_ROOM_KINDS } from "../../message/protected-room-topology.ts";
import {
  conversationProductTypedDb, executeTypedConversationProductQuery,
} from "../message/postgres-conversation-product-store.ts";

/** Revalidate M227 from the locked product rows, even for caller-supplied sets.
 * The source's top-level Namespace boundary governs inherited Subthreads too.
 * Cosmos remains a policy projection, never a crypto participant.
 */
export async function readableNamespacePolicyAllows(
  transaction: PostgresJsBridgeExecutor,
  input: Readonly<{
    sourceRoomId: string;
    sourceHumanIds: readonly string[];
    namespaceIds: readonly string[];
  }>,
): Promise<boolean> {
  const { sourceRoom, publicBoundaryRoom, publicBoundaryJoin, publicBoundaryRoomId } =
    createNamespaceBoundaryProjection();
  const allowed = await executeTypedConversationProductQuery(transaction,
    conversationProductTypedDb.select({ namespace_id: rooms.namespaceId })
      .from(rooms)
      .innerJoin(sourceRoom, eq(sourceRoom.id, input.sourceRoomId))
      .leftJoin(publicBoundaryRoom, publicBoundaryJoin)
      .where(and(
        sql`${rooms.namespaceId} = ANY(${sql.param([...input.namespaceIds])}::uuid[])`,
        isNull(rooms.parentRoomId),
        isNull(rooms.archivedAt),
        or(
          inArray(rooms.kind, [...PROTECTED_TOP_LEVEL_ROOM_KINDS]),
          // Immutable person-sharing boundaries remain readable from a
          // Human-only source audience, subject to the same subset check.
          // Public sources retain cosmos and therefore cannot use this branch.
          and(eq(rooms.kind, "access"), isNull(publicBoundaryRoomId)),
        ),
        or(
          and(isNull(publicBoundaryRoomId),
            sql`${moderationEffectiveHumanActorIdsSql(sql`${rooms.humanActorIds}`, sql`${rooms.id}`)} @> ${sql.param([...input.sourceHumanIds])}::uuid[]`),
          and(isNotNull(publicBoundaryRoomId),
            and(eq(rooms.kind, "open"), sql`${moderationEffectiveHumanActorIdsSql(sql`${rooms.humanActorIds}`, sql`${rooms.id}`)} @> ${sql.param([...input.sourceHumanIds])}::uuid[]`)),
        ),
      )).orderBy(rooms.namespaceId));
  return allowed.length === input.namespaceIds.length
    && allowed.every((row, index) => row.namespace_id === input.namespaceIds[index]);
}
