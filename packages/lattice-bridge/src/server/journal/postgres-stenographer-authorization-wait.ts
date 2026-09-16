import {actors, and, eq, exists, isNull, roomJournalState, roomMembers, sql, type DirectDatabase} from "@nautilo/db";
import type {StenographerExtractionLane} from "./stenographer-data-operation.ts";

export interface StenographerAuthorizationWaitPort {
  waiting(input: Readonly<{roomId: string; lane: StenographerExtractionLane | "compaction"; now: Date}>): Promise<void>;
  clear(input: Readonly<{roomId: string; lane: StenographerExtractionLane | "compaction"}>): Promise<void>;
}

/** The product lane exists before a Namespace bundle can describe a crypto
 * request. Persist only this otherwise unrepresented wait, never a failure. */
export function createPostgresStenographerAuthorizationWaitPort(db: DirectDatabase): StenographerAuthorizationWaitPort {
  return {
    async waiting({roomId, lane, now}) {
      const waitingSince = now.toISOString();
      const member = db.select({id: actors.id}).from(roomMembers)
        .innerJoin(actors, eq(actors.id, roomMembers.actorId))
        .where(and(eq(roomMembers.roomId, roomJournalState.roomId), eq(actors.kind, "agent")));
      await db.update(roomJournalState).set(lane === "compaction" ? {
        compactionAuthorizationWaitingSince: sql`COALESCE(${roomJournalState.compactionAuthorizationWaitingSince}, ${waitingSince})`,
        updatedAt: now,
      } : {
        extractionAuthorizationWaitLane: lane,
        extractionAuthorizationWaitingSince: sql`CASE WHEN ${roomJournalState.extractionAuthorizationWaitLane} = ${lane}
          THEN COALESCE(${roomJournalState.extractionAuthorizationWaitingSince}, ${waitingSince}) ELSE ${waitingSince} END`,
        updatedAt: now,
      }).where(and(eq(roomJournalState.roomId, roomId), isNull(roomJournalState.suspendedAt), exists(member)));
    },
    async clear({roomId, lane}) {
      await db.update(roomJournalState).set(lane === "compaction" ? {compactionAuthorizationWaitingSince: null}
        : {extractionAuthorizationWaitLane: null, extractionAuthorizationWaitingSince: null})
        .where(and(eq(roomJournalState.roomId, roomId), ...(lane === "compaction" ? [] : [eq(roomJournalState.extractionAuthorizationWaitLane, lane)])));
    },
  };
}
