import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { removeToolCallsFromAIMessage } from "./validate.js";

/**
 * D143 Layer 2 — canonical merge for BaseMessage[] arrays preserving
 * the FULL tool_use ↔ tool_result invariant Anthropic and OpenAI
 * both require: every `tool_use` block has exactly one `tool_result`,
 * no duplicate `tool_use_id`s anywhere in the conversation, no
 * orphan `tool_result` blocks.
 *
 * Right-side wins on tool_call_id collisions (latest-result-is-truth).
 * Dedupe is CLASS-AWARE — the collision rules differ for the two
 * sides of the invariant:
 *
 *   - **ToolMessage collision** (same tool_call_id appears as
 *     `ToolMessage.tool_call_id` on both sides): two tool responses
 *     for the same tool call. Right wins; drop the LEFT ToolMessage.
 *   - **AIMessage tool_call collision** (same id appears in
 *     `AIMessage.tool_calls[].id` on both sides): two assistant turns
 *     claiming the same tool_call_id — the approval-resume bug shape.
 *     Right wins; strip the colliding tool_call from the LEFT
 *     AIMessage (preserving its content). If the LEFT AIMessage has
 *     nothing left after the strip, drop it entirely.
 *
 * **NOT a collision**: LEFT AIMessage source for X + RIGHT
 * ToolMessage response for X. This is the normal happy-path pair —
 * the assistant emits tool_call X on the left, the tool executes
 * and produces ToolMessage(X) on the right. They pair across the
 * merge boundary; neither side gets stripped.
 *
 * The class-aware distinction is load-bearing. An earlier
 * implementation collapsed both sides into a single `rightToolCallIds`
 * set and stripped LEFT AIMessage tool_calls whenever RIGHT had ANY
 * message carrying that id — which broke the happy-path call site at
 * `packages/agent/src/nodes/tools.ts:414` because every tool
 * invocation has exactly the LEFT-AI + RIGHT-Tool shape. The fix is
 * to track AIMessage-source collisions and ToolMessage-response
 * collisions separately.
 *
 * Use everywhere two message arrays are combined; never use naked
 * `Array#concat` or `[...left, ...right]` on BaseMessage[]. The
 * sibling ESLint rule `nautilo-msg/no-naked-message-concat` enforces
 * this at code-review time.
 *
 * The dedupe axis is `tool_call_id`, not message-id, because
 * LangGraph's `messagesStateReducer` dedupes on message-id already
 * (Layer 1 makes that mechanism live by setting stable ids). This
 * helper is the defense for paths that BYPASS the reducer — direct
 * `updateState` with a merged array, manual splices, future
 * subagent merges — where the reducer's native dedupe isn't in the
 * loop.
 */
export function mergeMessagesPreservingInvariants(
  left: BaseMessage[],
  right: BaseMessage[],
): BaseMessage[] {
  // Class-aware dedupe sets.
  // rightAIToolCallIds: tool_call_ids that RIGHT claims via an
  //   AIMessage source. Collide with LEFT AIMessage sources (and
  //   LEFT ToolMessages for the same id, because those would now be
  //   stale relative to right's new claim).
  // rightToolMessageIds: tool_call_ids that RIGHT carries as a
  //   ToolMessage response. Collide ONLY with LEFT ToolMessages,
  //   NOT with LEFT AIMessage sources (those pair naturally with
  //   the right-side response).
  const rightAIToolCallIds = new Set<string>();
  const rightToolMessageIds = new Set<string>();
  for (const m of right) {
    if (m instanceof ToolMessage) {
      if (m.tool_call_id) rightToolMessageIds.add(m.tool_call_id);
      continue;
    }
    if (AIMessage.isInstance(m)) {
      for (const tc of m.tool_calls ?? []) {
        if (tc.id) rightAIToolCallIds.add(tc.id);
      }
    }
  }

  const leftFiltered: BaseMessage[] = [];
  for (const m of left) {
    // LEFT ToolMessage collides with EITHER a RIGHT ToolMessage
    // (same id = duplicate response, right wins) OR a RIGHT
    // AIMessage source (right is re-emitting the tool_call from
    // scratch, the LEFT response is now stale relative to the new
    // call). Both shapes drop the LEFT ToolMessage.
    if (m instanceof ToolMessage) {
      if (
        m.tool_call_id &&
        (rightToolMessageIds.has(m.tool_call_id) ||
          rightAIToolCallIds.has(m.tool_call_id))
      ) {
        continue;
      }
      leftFiltered.push(m);
      continue;
    }
    // LEFT AIMessage collides ONLY with RIGHT AIMessage sources for
    // the same tool_call_id. A RIGHT ToolMessage carrying the same
    // id is NOT a collision — it's the pair for this AIMessage's
    // tool_call. Strip only the colliding ids (those re-claimed by
    // a RIGHT AIMessage).
    if (AIMessage.isInstance(m)) {
      const tcs = m.tool_calls ?? [];
      const collidingIds = new Set(
        tcs
          .filter((tc) => tc.id && rightAIToolCallIds.has(tc.id))
          .map((tc) => tc.id!),
      );
      if (collidingIds.size === 0) {
        leftFiltered.push(m);
        continue;
      }
      const modified = removeToolCallsFromAIMessage(m, collidingIds);
      if (modified) leftFiltered.push(modified);
      // else: dropped entirely (no remaining tool_calls + no content)
      continue;
    }
    // Non-tool messages (Human, System, etc.) pass through unchanged.
    leftFiltered.push(m);
  }

  // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- canonical implementation; the right-wins dedupe above is what makes this spread safe.
  return [...leftFiltered, ...right];
}
