/**
 * D128 — post-turn fallback emission policy (Spacebot `skip_flag` / `replied_flag`).
 *
 * Nautilo streams assistant text as the model generates tokens and persists
 * AIMessages when graph nodes complete. This module is the agent-side gate
 * for suppressing the *fallback* tail when the model called `skip` (or already
 * sent an explicit reply via a future `reply` tool).
 */

import type { AgentTurnContext } from "./turn-context";
import { getAgentTurnContext, getAgentTurnContextByKey } from "./turn-context";

export type PostTurnFallbackContext = AgentTurnContext;

/**
 * Returns true when fallback assistant text should NOT be emitted for this turn.
 *
 * Decision 4 (D128): `skip` wins over fallback only. `replyAlreadySent` does not
 * block suppression when `skipFlag` is set — explicit replies already fired
 * synchronously; skip only inhibits the redundant follow-up text.
 */
export function shouldSuppressFallbackEmission(ctx: PostTurnFallbackContext): boolean {
  return ctx.skipFlag === true;
}

/**
 * Resolve post-turn context for a turn id (from executor ingress / stream processor).
 */
export function postTurnFallbackContextForTurn(turnId: string | undefined): PostTurnFallbackContext {
  if (!turnId?.trim()) return {};
  return getAgentTurnContext(turnId) ?? {};
}

/**
 * D421 Phase 4.2 — key-explicit variant for the per-agent slot. The
 * foreground executor passes the precomputed `turnContextId` so two bots
 * sharing one human `turnId` cannot read each other's `skipFlag`.
 */
export function postTurnFallbackContextForTurnByKey(key: string | undefined): PostTurnFallbackContext {
  const k = key?.trim();
  if (!k) return {};
  return getAgentTurnContextByKey(k) ?? {};
}

/**
 * Whether to persist / forward a fallback assistant text chunk after the turn.
 * `replyAlreadySent` is accepted for API symmetry with D128 tests; suppression
 * is driven solely by `skipFlag`.
 */
export function shouldEmitFallbackAssistantText(ctx: PostTurnFallbackContext): boolean {
  if (shouldSuppressFallbackEmission(ctx)) return false;
  return true;
}
