import {
  actors,
  and,
  count,
  eq,
  type InviteSeedTx,
  rooms,
  roomMembers,
  sessionMessages,
  sessions,
} from "@nautilo/db";
import type { DirectDatabase } from "@nautilo/db";
import type { AgentResponseMode } from "./queries";

export type { AgentResponseMode };
export type TrustDb = DirectDatabase;
export type ResponderDb = TrustDb | InviteSeedTx;

export type ShouldFireResult = {
  fire: boolean;
  reason:
    | "active"
    | "mention"
    | "reply_to_agent"
    | "slash_command"
    | "suppressed_by_mode"
    | "suppressed_no_mention";
  effectiveMode: AgentResponseMode;
};

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip triple-backtick fenced regions (odd segments after split are inside fences). */
export function contentOutsideCodeFences(content: string): string {
  const parts = content.split("```");
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    out += parts[i] ?? "";
  }
  return out;
}

/**
 * Strict @<handle> + reply-to-agent + slash-command parser. Per D128
 * Decision 2: NO fuzzy matching.
 */
export function parseAgentMentions(
  content: string,
  agentHandle: string,
): {
  hasMention: boolean;
  hasSlashCommand: boolean;
} {
  const trimmed = content.trim();
  if (!trimmed) {
    return { hasMention: false, hasSlashCommand: false };
  }

  const hasSlashCommand = /^\s*\/[A-Za-z][\w-]*/.test(content);

  if (!agentHandle) {
    return { hasMention: false, hasSlashCommand };
  }

  const scan = contentOutsideCodeFences(content);
  const handle = escapeRegexLiteral(agentHandle);
  // Require non-word char before @ (or start) and word-boundary after handle / @server tail.
  const mentionRe = new RegExp(
    `(?:^|[^\\w])@${handle}(?:@[^\\s@]+)?(?=$|[^\\w])`,
  );
  const hasMention = mentionRe.test(scan);

  return { hasMention, hasSlashCommand };
}

async function countRoomMembersByKind(
  db: TrustDb,
  roomId: string,
): Promise<{ humanCount: number; agentCount: number }> {
  const rows = await db
    .select({
      kind: actors.kind,
      c: count(),
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(eq(roomMembers.roomId, roomId))
    .groupBy(actors.kind);

  let humanCount = 0;
  let agentCount = 0;
  for (const r of rows) {
    const n = Number(r.c);
    if (r.kind === "user") humanCount = n;
    if (r.kind === "agent") agentCount = n;
  }
  return { humanCount, agentCount };
}

async function loadEffectiveMode(
  db: TrustDb,
  roomId: string,
  agentActorId: string,
): Promise<AgentResponseMode> {
  const { humanCount, agentCount } = await countRoomMembersByKind(db, roomId);
  if (humanCount === 1 && agentCount >= 1) {
    return "active";
  }

  const [row] = await db
    .select({ mode: roomMembers.agentResponseMode })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, agentActorId)))
    .limit(1);

  const stored = row?.mode;
  if (stored === "active" || stored === "mention_only" || stored === "observe") {
    return stored;
  }
  return humanCount >= 2 ? "mention_only" : "active";
}

async function isReplyToAgentMessage(
  db: TrustDb,
  roomId: string,
  agentActorId: string,
  replyToMessageId: number,
): Promise<boolean> {
  const [agentRow] = await db
    .select({ agentId: actors.agentId })
    .from(actors)
    .where(and(eq(actors.id, agentActorId), eq(actors.kind, "agent")))
    .limit(1);
  if (!agentRow?.agentId) return false;

  const [parent] = await db
    .select({
      role: sessionMessages.role,
      sessionAgentId: sessions.agentId,
      sessionRoomId: sessions.roomId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, replyToMessageId))
    .limit(1);

  if (!parent?.sessionRoomId || parent.sessionRoomId !== roomId) return false;
  return parent.role === "assistant" && parent.sessionAgentId === agentRow.agentId;
}

/**
 * M134 Phase 2 — resolve the agent ACTOR id a `replyToMessageId` points at,
 * or null when the parent is not an in-room assistant message. Powers the
 * Room Conductor's `resolveReplyTargetActorId` dependency.
 */
export async function findReplyTargetAgentActorId(
  db: TrustDb,
  roomId: string,
  replyToMessageId: number,
): Promise<string | null> {
  if (!Number.isInteger(replyToMessageId) || replyToMessageId < 1) return null;

  const [parent] = await db
    .select({
      role: sessionMessages.role,
      sessionAgentId: sessions.agentId,
      sessionRoomId: sessions.roomId,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .where(eq(sessionMessages.id, replyToMessageId))
    .limit(1);

  if (!parent?.sessionAgentId) return null;
  if (parent.role !== "assistant") return null;
  if (!parent.sessionRoomId || parent.sessionRoomId !== roomId) return null;

  const [actorRow] = await db
    .select({ actorId: actors.id })
    .from(actors)
    .where(and(eq(actors.agentId, parent.sessionAgentId), eq(actors.kind, "agent")))
    .limit(1);

  return actorRow?.actorId ?? null;
}

/**
 * M134 Phase 2 — per-(Room) agent members with their stored
 * `agent_response_mode`. The Conductor reads the STORED mode directly (it
 * does NOT reuse `loadEffectiveMode`'s DM `active` override — the group/DM
 * split happens at the dispatch layer).
 */
export async function findRoomAgentResponseModes(
  db: TrustDb,
  roomId: string,
): Promise<
  Array<{ actorId: string; agentId: string | null; mode: AgentResponseMode | null }>
> {
  const rows = await db
    .select({
      actorId: roomMembers.actorId,
      agentId: actors.agentId,
      mode: roomMembers.agentResponseMode,
    })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(and(eq(roomMembers.roomId, roomId), eq(actors.kind, "agent")));

  return rows.map((r) => ({
    actorId: r.actorId,
    agentId: r.agentId ?? null,
    mode:
      r.mode === "active" || r.mode === "mention_only" || r.mode === "observe"
        ? r.mode
        : null,
  }));
}

/**
 * D128 — decide whether a given agent should fire an LLM turn for an
 * inbound message.
 */
export async function shouldFireLLMTurn(
  db: TrustDb,
  params: {
    roomId: string;
    agentActorId: string;
    agentHandle: string;
    message: { content: string; replyToMessageId?: number | null };
  },
): Promise<ShouldFireResult> {
  const mode = await loadEffectiveMode(db, params.roomId, params.agentActorId);
  const parsed = parseAgentMentions(params.message.content, params.agentHandle);

  if (mode === "observe") {
    return { fire: false, reason: "suppressed_by_mode", effectiveMode: mode };
  }

  if (mode === "active") {
    return { fire: true, reason: "active", effectiveMode: mode };
  }

  // mention_only
  if (parsed.hasMention) {
    return { fire: true, reason: "mention", effectiveMode: mode };
  }
  if (parsed.hasSlashCommand) {
    return { fire: true, reason: "slash_command", effectiveMode: mode };
  }

  const replyId = params.message.replyToMessageId;
  if (replyId != null && Number.isInteger(replyId) && replyId > 0) {
    if (await isReplyToAgentMessage(db, params.roomId, params.agentActorId, replyId)) {
      return { fire: true, reason: "reply_to_agent", effectiveMode: mode };
    }
  }

  return { fire: false, reason: "suppressed_no_mention", effectiveMode: mode };
}

export type SubthreadResponderEligibilityStatus =
  | "eligible"
  | "unavailable_not_subthread"
  | "unavailable_archived"
  | "unavailable_no_parent"
  | "unavailable_not_member"
  | "unavailable_observe";

export interface SubthreadResponderEligibility {
  status: SubthreadResponderEligibilityStatus;
  mode: AgentResponseMode | null;
  parentRoomId: string | null;
}

/** Resolve child responder eligibility from the authoritative parent membership. */
export async function resolveSubthreadAgentEligibility(
  db: ResponderDb,
  subthreadRoomId: string,
  botActorId: string,
): Promise<SubthreadResponderEligibility> {
  const [room] = await db
    .select({ kind: rooms.kind, parentRoomId: rooms.parentRoomId, archivedAt: rooms.archivedAt })
    .from(rooms)
    .where(eq(rooms.id, subthreadRoomId))
    .limit(1);
  if (!room || room.kind !== "subthread") {
    return { status: "unavailable_not_subthread", mode: null, parentRoomId: null };
  }
  if (room.archivedAt != null) {
    return { status: "unavailable_archived", mode: null, parentRoomId: room.parentRoomId ?? null };
  }
  if (!room.parentRoomId) {
    return { status: "unavailable_no_parent", mode: null, parentRoomId: null };
  }
  const [member] = await db
    .select({ mode: roomMembers.agentResponseMode })
    .from(roomMembers)
    .innerJoin(actors, eq(roomMembers.actorId, actors.id))
    .where(and(
      eq(roomMembers.roomId, room.parentRoomId),
      eq(roomMembers.actorId, botActorId),
      eq(actors.kind, "agent"),
    ))
    .limit(1);
  if (!member) {
    return { status: "unavailable_not_member", mode: null, parentRoomId: room.parentRoomId };
  }
  const mode: AgentResponseMode =
    member.mode === "mention_only" || member.mode === "observe" || member.mode === "active"
      ? member.mode
      : "active";
  return mode === "observe"
    ? { status: "unavailable_observe", mode, parentRoomId: room.parentRoomId }
    : { status: "eligible", mode, parentRoomId: room.parentRoomId };
}

export async function listSubthreadRoomIdsForParent(
  db: ResponderDb,
  parentRoomId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.parentRoomId, parentRoomId), eq(rooms.kind, "subthread")));
  return rows.map((row) => row.id);
}
