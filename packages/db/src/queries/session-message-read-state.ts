import { isNull } from "drizzle-orm";
import type { Database } from "../config/database";
import { sessionMessageRecipientState } from "../schema/session-message-recipient-state";

/** Preserve the first delivery timestamp while making repeat stamps harmless. */
export async function markMessageRecipientDeliveredWith(
  db: Database,
  messageId: number,
  recipientId: string,
  deliveredAt = new Date(),
): Promise<void> {
  await db
    .insert(sessionMessageRecipientState)
    .values({ messageId, recipientId, deliveredAt })
    .onConflictDoUpdate({
      target: [
        sessionMessageRecipientState.messageId,
        sessionMessageRecipientState.recipientId,
      ],
      set: { deliveredAt },
      setWhere: isNull(sessionMessageRecipientState.deliveredAt),
    });
}

/**
 * Stamp a recipient read exactly once. Returning true is the durable
 * unread-to-read transition signal used by notification publication.
 */
export async function markMessageRecipientReadWith(
  db: Database,
  messageId: number,
  recipientId: string,
  readAt = new Date(),
): Promise<boolean> {
  const rows = await db
    .insert(sessionMessageRecipientState)
    .values({ messageId, recipientId, readAt })
    .onConflictDoUpdate({
      target: [
        sessionMessageRecipientState.messageId,
        sessionMessageRecipientState.recipientId,
      ],
      set: { readAt },
      setWhere: isNull(sessionMessageRecipientState.readAt),
    })
    .returning({ messageId: sessionMessageRecipientState.messageId });
  return rows.length > 0;
}
