/**
 * D426 Phase 2 — resolve the root Genie affinity for a Subthread: the agent
 * actor that authored the anchor (root) message, plus its current eligibility
 * against the PARENT Room's `room_members.agent_response_mode`.
 *
 * The affinity rule (see `packages/runtime/src/conductor/conductor.ts`
 * step 5.5): for the first visible, otherwise-natural child message in a
 * Subthread, the root Genie is the one-shot inferred candidate. Normal
 * requester-private Room focus is resolved before this helper. An unavailable
 * root Genie (parent `observe` / removed) stays silent/controlled rather than
 * falling through to normal history / floor arbitration for that first turn.
 *
 * `botActorId: null` means there is no root Genie affinity to apply — the
 * anchor was human-authored (or the anchor was deleted / the room is not a
 * Subthread). The conductor then falls through to history / floor
 * arbitration.
 */
import {
  actors,
  and,
  eq,
  rooms,
  sessionMessages,
  sessions,
  sql,
} from "@nautilo/db";
import { resolveSubthreadAgentEligibility, type ResponderDb } from "@nautilo/trust";

export interface SubthreadRootAffinity {
  /** Agent actor id of the anchor author; null when the anchor is human-authored / absent. */
  botActorId: string | null;
  /** True when the root Genie is an eligible agent member of the parent Room. */
  available: boolean;
}

/**
 * Resolve the root Genie affinity for a Subthread Room. Accepts either a
 * direct postgres-js pool or a drizzle transaction (the conductor dispatch
 * passes the process-wide direct handle; tests may pass a tx).
 */
export async function resolveSubthreadRootAffinity(
  db: ResponderDb,
  subthreadRoomId: string,
  currentMessageId: number | null,
): Promise<SubthreadRootAffinity> {
  if (!subthreadRoomId || currentMessageId == null) {
    return { botActorId: null, available: false };
  }

  const [room] = await db
    .select({
      kind: rooms.kind,
      threadRootMessageId: rooms.threadRootMessageId,
    })
    .from(rooms)
    .where(eq(rooms.id, subthreadRoomId))
    .limit(1);

  if (!room || room.kind !== "subthread") {
    return { botActorId: null, available: false };
  }

  // Dispatch persists the current human child turn before routing it. Root
  // affinity is a one-shot first-visible-reply rule, so an earlier visible
  // user/assistant row makes this a normal history/Floor Manager turn. Tool
  // rows, empty assistant rows, and task reports deliberately do not count.
  const [earlierVisibleChildReply] = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(
      and(
        eq(sessionMessages.subthreadRoomId, subthreadRoomId),
        sql`${sessionMessages.id} < ${currentMessageId}`,
        sql`${sessionMessages.role} IN ('user','assistant')`,
        sql`(${sessionMessages.role} = 'user' OR ${sessionMessages.content} <> '')`,
        sql`(${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'task' AND (${sessionMessages.metadata}->>'originatedBy') IS DISTINCT FROM 'connected_web_operation'`,
      ),
    )
    .limit(1);
  if (earlierVisibleChildReply) {
    return { botActorId: null, available: false };
  }
  const rootMessageId = room.threadRootMessageId ?? null;
  if (rootMessageId == null) {
    // Anchor was deleted (tombstoned) — no root Genie affinity.
    return { botActorId: null, available: false };
  }

  const [anchor] = await db
    .select({
      role: sessionMessages.role,
      sessionAgentId: sessions.agentId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, rootMessageId))
    .limit(1);

  if (!anchor || anchor.role !== "assistant" || !anchor.sessionAgentId) {
    // Anchor authored by a human (or unknown) — no root Genie affinity.
    return { botActorId: null, available: false };
  }

  const [actorRow] = await db
    .select({ actorId: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, anchor.sessionAgentId), eq(actors.kind, "agent")))
    .limit(1);

  if (!actorRow?.actorId) {
    return { botActorId: null, available: false };
  }

  const elig = await resolveSubthreadAgentEligibility(db, subthreadRoomId, actorRow.actorId);
  return {
    botActorId: actorRow.actorId,
    available: elig.status === "eligible",
  };
}
