import type { ActiveFocus } from "@nautilo/trust";
import type { ConductorMessage, RoomMemberView } from "./types";
import type { RoomHistoryHit } from "./history-search";

/**
 * Distinct wakeable bot actor ids authored in `hits`. Used by the
 * single-owner gate and multi-owner ambiguity handling.
 */
export function historyBotOwners(
  hits: RoomHistoryHit[],
  active: ActiveFocus[],
  candidates: RoomMemberView[],
): string[] {
  const candidateBotIds = new Set(
    candidates.filter((c) => c.kind === "agent").map((c) => c.actorId),
  );
  const focusBotIds = new Set(
    active.map((f) => f.botActorId).filter((id) => candidateBotIds.has(id)),
  );
  const wakeable = new Set<string>([...candidateBotIds, ...focusBotIds]);

  const botAuthors = new Set<string>();
  for (const hit of hits) {
    if (wakeable.has(hit.authorActorId)) botAuthors.add(hit.authorActorId);
  }
  return [...botAuthors];
}

/**
 * M135 Phase 7 (D-B) — deterministic single-owner resolution over history
 * evidence. Returns a bot ACTOR id ONLY when the evidence points at exactly
 * one clear candidate-bot owner; otherwise `null` (defer to the Floor
 * Manager). Never fans out, never wakes a non-candidate (muted) bot.
 */
export function deterministicHistoryOwner(
  hits: RoomHistoryHit[],
  active: ActiveFocus[],
  candidates: RoomMemberView[],
): string | null {
  const owners = historyBotOwners(hits, active, candidates);
  return owners.length === 1 ? owners[0]! : null;
}

/**
 * M135 Phase 7 — conservative, LANGUAGE-AGNOSTIC gate deciding whether a
 * message warrants a room-history search. Structural signals ONLY (per spec):
 * NO catch-phrase regex. v1 default is `false`.
 *
 * Returns true only when the message explicitly references older context:
 *   - an explicit UI "search room history" flag, OR
 *   - a reply that points at an OLDER message (not the immediately-preceding
 *     turn). The caller supplies `precedingMessageId` (the id of the turn
 *     right before this one) so we can tell "reply to the last line"
 *     (→ false; that is just a normal reply) from "reply to something old"
 *     (→ true).
 */
export function messageNeedsHistory(
  message: ConductorMessage,
  opts: { precedingMessageId?: number | null; searchHistoryFlag?: boolean } = {},
): boolean {
  if (opts.searchHistoryFlag === true) return true;

  const replyId = message.replyToMessageId;
  if (replyId != null && Number.isInteger(replyId) && replyId > 0) {
    const preceding = opts.precedingMessageId;
    // Reply to the immediately-preceding turn is an ordinary reply, not a
    // history lookup. Any older reply target signals a past-context question.
    if (preceding != null && Number.isInteger(preceding)) {
      return replyId < preceding;
    }
    // Unknown preceding turn: a reply still references prior context — but to
    // stay conservative when we cannot disambiguate, do NOT trigger search.
    return false;
  }

  return false;
}
