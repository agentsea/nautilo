import { getSharedDirectDb } from "@nautilo/db";
import {
  deleteMessageHardInTx,
  type CanonicalHardDeleteEffects,
} from "./canonical-transcript-mutations";

/**
 * ISSUE-M172 — hard-deletes a single session_messages row. Caller MUST have
 * already passed assertUserCanDeleteMessage. Every canonical effect runs in
 * one transaction so a concurrent delete cannot double-decrement
 * message_count.
 *
 * The transaction-scoped primitive is exported separately for protected
 * callers that must persist a lifecycle receipt before the same commit.
 */
export async function deleteMessageHard(
  messageId: number,
): Promise<CanonicalHardDeleteEffects> {
  const db = getSharedDirectDb();
  return db.transaction((tx) => deleteMessageHardInTx(tx, messageId));
}
