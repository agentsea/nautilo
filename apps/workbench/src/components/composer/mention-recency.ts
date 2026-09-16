/**
 * D210 Stack-32 polish — recency ranking for the @-mention picker.
 *
 * Builds `actorId → latest message epoch-ms` from the runtime thread frame
 * (`sourceUserId` on human messages from rehydrate + WS; assistant messages
 * attributed to room agent members). Pure functions only — no React.
 */

import type { RoomMemberDto } from "@nautilo/types";

export type MentionThreadMessage = {
  readonly role?: string;
  readonly createdAt?: unknown;
  readonly metadata?: { readonly custom?: { readonly sourceUserId?: unknown } };
};

const EMPTY_LAST_SPOKE = new Map<string, number>();

function messageCreatedAtMs(createdAt: unknown): number | undefined {
  if (createdAt instanceof Date) {
    const t = createdAt.getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof createdAt === "string") {
    const t = Date.parse(createdAt);
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
  return undefined;
}

/**
 * Derive per-member recency from the visible thread transcript. Keys are
 * `RoomMemberDto.actorId` (not `userId`) so the map plugs into member sort.
 */
export function buildLastSpokeAtMsFromThread(
  messages: readonly MentionThreadMessage[],
  members: readonly RoomMemberDto[],
  viewerUserId?: string  ,
): ReadonlyMap<string, number> {
  const userIdToActorId = new Map<string, string>();
  const agentActorIds: string[] = [];
  for (const m of members) {
    if (m.kind === "user" && typeof m.userId === "string" && m.userId.length > 0) {
      userIdToActorId.set(m.userId, m.actorId);
    }
    if (m.kind === "agent") agentActorIds.push(m.actorId);
  }

  const spoke = new Map<string, number>();
  const bump = (actorId: string, ms: number): void => {
    const prev = spoke.get(actorId);
    if (prev === undefined || ms > prev) spoke.set(actorId, ms);
  };

  for (const msg of messages) {
    const ms = messageCreatedAtMs(msg.createdAt);
    if (ms === undefined) continue;

    if (msg.role === "user") {
      const raw = msg.metadata?.custom?.sourceUserId;
      const sourceUserId = typeof raw === "string" && raw.length > 0 ? raw : undefined;
      if (sourceUserId) {
        const actorId = userIdToActorId.get(sourceUserId);
        if (actorId) bump(actorId, ms);
      } else if (viewerUserId) {
        const actorId = userIdToActorId.get(viewerUserId);
        if (actorId) bump(actorId, ms);
      }
    } else if (msg.role === "assistant" && agentActorIds.length > 0) {
      for (const actorId of agentActorIds) bump(actorId, ms);
    }
  }

  return spoke;
}

/**
 * Recent speakers first; silent members fall back to alphabetical display name.
 */
export function compareMentionMembersByRecency(
  a: RoomMemberDto,
  b: RoomMemberDto,
  lastSpokeAtMs: ReadonlyMap<string, number>,
): number {
  const ta = lastSpokeAtMs.get(a.actorId);
  const tb = lastSpokeAtMs.get(b.actorId);
  if (ta !== tb) {
    if (ta === undefined) return 1;
    if (tb === undefined) return -1;
    return tb - ta;
  }
  return a.displayName.localeCompare(b.displayName);
}

export function sortMembersForMentionPicker(
  members: readonly RoomMemberDto[],
  lastSpokeAtMs: ReadonlyMap<string, number> = EMPTY_LAST_SPOKE,
): RoomMemberDto[] {
  return [...members].sort((a, b) => compareMentionMembersByRecency(a, b, lastSpokeAtMs));
}
