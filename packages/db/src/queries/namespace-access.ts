import {
  and,
  eq,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { rooms } from "../schema/rooms";

/**
 * M227 — derive the virtual `cosmos` boundary from canonical Room state.
 * Subthreads inherit the result because they share the top-level Room's
 * Namespace.
 *
 * This correlated predicate is safe in a WHERE clause. Do not select it as a
 * projected expression: Drizzle removes the outer Room qualifier while
 * serializing nested selections, turning the correlation into an inner
 * `namespace_id = namespace_id` comparison. Use
 * {@link createNamespaceBoundaryProjection} for selected Room access rows.
 */
export function publicNamespaceBoundarySql(namespaceId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM rooms AS public_boundary_room
    WHERE public_boundary_room.namespace_id = ${namespaceId}
      AND public_boundary_room.kind = 'open'
  )`;
}

/** M227 — fail closed for resolvers that require a human-only audience. */
export function privateNamespaceBoundarySql(namespaceId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`NOT ${publicNamespaceBoundarySql(namespaceId)}`;
}

/**
 * M227 — alias-safe selected projection for a Room's virtual `cosmos`
 * boundary. The explicit self-join keeps both Namespace operands qualified in
 * generated SQL. A subthread is public when its shared Namespace has an open
 * top-level Room.
 */
export function createNamespaceBoundaryProjection() {
  const sourceRoom = alias(rooms, "namespace_source_room");
  const publicBoundaryRoom = alias(rooms, "public_boundary_room");
  return {
    sourceRoom,
    publicBoundaryRoom,
    publicBoundaryJoin: and(
      eq(publicBoundaryRoom.namespaceId, sourceRoom.namespaceId),
      eq(publicBoundaryRoom.kind, "open"),
    )!,
    publicBoundaryRoomId: publicBoundaryRoom.id,
  };
}

/**
 * M044/M227 — the ordinary human-set containment predicate, narrowed to
 * public candidate boundaries when the source effective audience contains
 * virtual `cosmos`.
 */
export function namespaceSubsetPredicate(
  humanActorIds: string[],
  isPublicNamespaceBoundary: boolean,
): SQL {
  const containsSourceHumans = sql`${rooms.humanActorIds} @> ARRAY[${sql.join(
    humanActorIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  return isPublicNamespaceBoundary
    ? and(containsSourceHumans, eq(rooms.kind, "open"))!
    : containsSourceHumans;
}
