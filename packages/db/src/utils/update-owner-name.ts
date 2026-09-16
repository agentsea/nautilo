import { eq } from "drizzle-orm";
import { getSharedDirectDb } from "../config/direct-database";
import { users } from "../schema/users";
import { actors } from "../schema/trust";

/**
 * Update the display name for the owner's user row AND their actor row.
 * Both must stay in sync — users.name is the DB record, actors.displayName
 * is what the trust layer returns as actorLabel to clients.
 */
export async function updateOwnerName(ownerId: string, name: string): Promise<void> {
  const db = getSharedDirectDb();
  const trimmed = name.trim();
  await db
    .update(users)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(users.id, ownerId));
  await db
    .update(actors)
    .set({ displayName: trimmed, updatedAt: new Date() })
    .where(eq(actors.ownerId, ownerId));
}
