import { and, eq, sql, actors, users, moderationBanAbsentSql, type InviteSeedTx } from "@nautilo/db";
import { ModerationError } from "./moderation-policy";

/** Serialize Human enrollment with moderation before taking any Room locks. */
export async function lockMembershipHumanInTx(tx: InviteSeedTx, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
}

/** Existing membership writers retain authority; a ban can only subtract it. */
export async function roomMembershipIsBannedInTx(tx: InviteSeedTx, actorId: string, roomId: string): Promise<boolean> {
  const [banned] = await tx.select({ id: actors.id }).from(actors).where(and(
    eq(actors.id, actorId), eq(actors.kind, "user"),
    sql`NOT ${moderationBanAbsentSql(sql`${actors.ownerId}`, sql`${roomId}`)}`,
  )).limit(1);
  return banned !== undefined;
}

export async function assertRoomMembershipNotBannedInTx(tx: InviteSeedTx, actorId: string, roomId: string): Promise<void> {
  if (await roomMembershipIsBannedInTx(tx, actorId, roomId)) throw new ModerationError("active_ban");
}
