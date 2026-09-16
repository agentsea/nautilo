import { and, desc, eq, isNotNull, like } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { sessionMessages, sessions } from "../schema/sessions";

const LEGACY_MANAGE_AVATAR_TRANSCRIPT_QUERY_LIMIT = 5_001;

/**
 * Read the bounded transcript evidence used by the legacy manage-avatar
 * backfill. Exact success-message validation remains the caller's concern.
 */
export async function listLegacyManageAvatarTranscriptCandidatesWith(
  db: DirectDatabase,
) {
  return db
    .select({
      messageId: sessionMessages.id,
      content: sessionMessages.content,
      createdAt: sessionMessages.createdAt,
      ownerUserId: sessions.ownerId,
      agentId: sessions.agentId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .where(and(
      eq(sessionMessages.role, "tool"),
      eq(sessionMessages.toolName, "manage_avatar"),
      isNotNull(sessions.agentId),
      like(sessionMessages.content, "Avatar set to % image (%)."),
    ))
    .orderBy(desc(sessionMessages.id))
    .limit(LEGACY_MANAGE_AVATAR_TRANSCRIPT_QUERY_LIMIT);
}
