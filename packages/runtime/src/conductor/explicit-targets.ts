import { parseAgentMentions } from "@nautilo/trust";
import type { ConductorSource, RoomMemberView } from "./types";

export interface ExplicitTarget {
  actorId: string;
  source: ConductorSource;
}

/**
 * Resolve strict @handle mentions of human room members. This deliberately
 * reuses the same parser as agent mentions, including its exact-token and
 * fenced-code behavior. The caller supplies only non-sender human members.
 *
 * This is not a wake target resolver: a human mention suppresses later bot
 * inference only after eligible explicit agent targets have had precedence.
 */
export function resolveExplicitHumanMentionTargets(
  content: string,
  humanMembers: readonly RoomMemberView[],
): RoomMemberView[] {
  return humanMembers.filter((member) => {
    if (member.kind !== "user" || !member.handle) return false;
    return parseAgentMentions(content, member.handle).hasMention;
  });
}

/**
 * M134 Phase 2 — deterministic explicit targeting over the `candidates` set
 * (already filtered to non-`observe` agents). A muted bot is never reachable
 * here because it is excluded from `candidates` by the caller.
 *
 * Pure: the reply-to-agent DB lookup is resolved up-front by the caller and
 * passed in as `replyTargetActorId`.
 *
 * Precedence for the decision-level `source`: mention > reply > ui. The
 * returned `botActorIds` are the UNION of all explicit targets (multi-mention
 * is the only deterministic multi-wake path).
 */
export function resolveExplicitTargets(
  message: {
    content: string;
    uiSelectedBotActorId?: string | null;
  },
  candidates: RoomMemberView[],
  replyTargetActorId: string | null,
): ExplicitTarget[] {
  const byActor = new Map<string, ConductorSource>();
  const rank: Record<ConductorSource, number> = {
    mention: 0,
    reply: 1,
    ui: 2,
    inferred: 3,
  };
  const consider = (actorId: string, source: ConductorSource) => {
    const prev = byActor.get(actorId);
    if (prev === undefined || rank[source] < rank[prev]) {
      byActor.set(actorId, source);
    }
  };

  // 1. Mentions (per agent handle). Multi-mention => multiple targets.
  for (const c of candidates) {
    if (!c.handle) continue;
    const { hasMention } = parseAgentMentions(message.content, c.handle);
    if (hasMention) consider(c.actorId, "mention");
  }

  // 2. Reply-to-agent — only when the resolved target is a candidate.
  if (replyTargetActorId && candidates.some((c) => c.actorId === replyTargetActorId)) {
    consider(replyTargetActorId, "reply");
  }

  // 3. UI selection — only when it names a candidate.
  const ui = message.uiSelectedBotActorId;
  if (ui && candidates.some((c) => c.actorId === ui)) {
    consider(ui, "ui");
  }

  return [...byActor.entries()].map(([actorId, source]) => ({ actorId, source }));
}
