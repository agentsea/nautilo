import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { warn } from "@nautilo/logger";

/**
 * D143 Layer 4 — dev-mode invariant assertions.
 *
 * Asserts that `messages` contains no two `ToolMessage`s sharing a
 * `tool_call_id`. In dev/test (`NODE_ENV !== "production"`), throws
 * on violation with the duplicate's location for fast feedback. In
 * production, log-only (Layer 3's safety-net pass repairs it
 * downstream; throwing would convert a recoverable Anthropic 400
 * into a crashed turn, which is worse).
 *
 * Called at architectural seams where the invariant should hold:
 *   - end of pre_model, right before send-to-LLM
 *   - inside splice-fork-result after the merge
 *   - any future merge site
 *
 * The `where` parameter is a free-form label that surfaces in the
 * error / warning message so the failure point is clear in logs
 * (e.g. "pre_model.before_llm", "splice-fork-result.after_merge").
 *
 * Cost: O(n) scan, ~50 ns per message. Cheap enough to live in
 * production's hot path; the production behavior is warn-only so
 * the only cost is the scan itself.
 */
export function assertMessageInvariants(
  messages: BaseMessage[],
  where: string,
): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg instanceof ToolMessage && msg.tool_call_id) {
      const prev = seen.get(msg.tool_call_id);
      if (prev !== undefined) {
        const errMsg =
          `[${where}] D143 invariant violated: duplicate ToolMessage ` +
          `tool_call_id=${msg.tool_call_id} at idx ${i} (prev at idx ${prev})`;
        if (process.env["NODE_ENV"] === "production") {
          warn(errMsg);
          // continue scanning so the warning logs every duplicate, not just
          // the first. Layer 3 repairs them all downstream.
        } else {
          throw new Error(errMsg);
        }
      }
      seen.set(msg.tool_call_id, i);
    }
  }
}
