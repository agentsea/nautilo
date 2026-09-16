import { actors, and, eq, getSharedDirectDb, roomMembers, rooms } from "@nautilo/db";
import { userHasCapability } from "@nautilo/trust";

export class ManageForbiddenError extends Error {
  constructor() {
    super("forbidden");
    this.name = "ManageForbiddenError";
  }
}

/**
 * D543 — caller may manage the Room when they hold the server-wide
 * `manage_rooms` capability, own this Room, or hold the durable per-Room
 * `room_members.room_role = 'admin'` assignment. These authorities are kept
 * distinct because only the server-wide tier may cross global privacy rails.
 */
export type RoomManagementAuthority =
  | { role: "server_room_admin" }
  | { role: "room_owner" }
  | { role: "room_admin" };

export async function assertCallerCanManageRoom(
  callerUserId: string,
  roomId: string,
): Promise<RoomManagementAuthority> {
  if (await userHasCapability(callerUserId, "manage_rooms")) {
    return { role: "server_room_admin" };
  }
  const db = getSharedDirectDb();
  const [row] = await db
    .select({ ownerId: rooms.ownerId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!row) throw new ManageForbiddenError();
  if (row.ownerId === callerUserId) {
    return { role: "room_owner" };
  }
  const [membership] = await db
    .select({ roomRole: roomMembers.roomRole })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(
      and(
        eq(roomMembers.roomId, roomId),
        eq(roomMembers.roomRole, "admin"),
        eq(actors.kind, "user"),
        eq(actors.ownerId, callerUserId),
      ),
    )
    .limit(1);
  if (membership) {
    return { role: "room_admin" };
  }
  throw new ManageForbiddenError();
}
