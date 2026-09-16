import { HumanMessage } from "@langchain/core/messages";

/**
 * Minimal shape of the compiled Nautilo graph the fork path interacts with.
 * Retained here (rather than in the deleted `splice-fork-result.ts`) so the
 * fork executor can type its `createNautiloGraph(...)` cast.
 */
export type CompiledNautiloGraph = {
  getState(
    config: Record<string, unknown>,
  ): Promise<{ values: Record<string, unknown>; tasks?: unknown } | undefined>;
  updateState(
    inputConfig: Record<string, unknown>,
    values: Record<string, unknown>,
    asNode?: string,
  ): Promise<unknown>;
  streamEvents(
    input: unknown,
    config?: Record<string, unknown>,
  ): AsyncIterable<unknown>;
};

/**
 * M170 R2b — transient in-flight-predecessor marker.
 *
 * A fork-on-busy turn now rebuilds its history from the DB transcript (R1), so
 * the predecessor's *committed* user message is already in that history. This
 * marker is the surviving, slimmed successor of the old `syntheticBackgroundNote`
 * (the checkpoint-copy splice machinery is gone): it only tells the fork "the
 * preceding request(s) shown above are already being handled in the background —
 * do not redo that work," so a fork does not re-answer an in-flight predecessor
 * (the Athens/Thessaloniki case).
 *
 * Invariants (unchanged from the old note):
 *  - `HumanMessage`, never `AIMessage` — it is not a fake assistant reply, and a
 *    mid-conversation `SystemMessage` is rejected by Anthropic.
 *  - `additional_kwargs.nautilo_transient_context: true` — `persistMessages`
 *    skips it at the persistence boundary, so it lives ONLY in the ephemeral
 *    fork checkpoint and never reaches the visible transcript. With the splice
 *    gone there is no other escape path.
 *  - It reads NOTHING from the checkpoint and takes only the in-flight count.
 */
export function buildForkBackgroundMarker(pendingCount: number): HumanMessage {
  const plural = pendingCount !== 1;
  const subject = plural ? "requests" : "request";
  const verb = plural ? "are" : "is";
  return new HumanMessage({
    content:
      `[FORK BACKGROUND] The preceding user ${subject} shown above ${verb} ` +
      `already being handled in the background. Do not redo that work; respond ` +
      `only to the new request that follows.`,
    additional_kwargs: {
      nautilo_transient_context: true,
    },
  });
}
