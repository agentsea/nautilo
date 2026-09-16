import { interrupt } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import type { NautiloState } from "../agent/state";

/**
 * M151 (Task Phase 7a) — park a run that must wait for a human reply.
 *
 * Reached only when `awaitResponse` is set AND the turn produced a final
 * message (no pending tool calls — `shouldContinue` routed here instead of
 * `tools`). Raises `await_human_reply`, which persists the checkpoint exactly
 * like `approval_ask`. Resume injects the human reply via
 * `resumeGraphWithHumanReply`.
 *
 * First entry: `interrupt()` parks + persists the checkpoint — it never
 * "returns" on the first pass (LangGraph throws to suspend the graph). On
 * resume (`Command({resume:{reply,fromUserId}})`) the SAME `interrupt()` call
 * returns the resume value; we inject the reply as a `HumanMessage` AND clear
 * `awaitResponse` so the post-reply turn reaches real `END` instead of
 * re-parking on a second `await_human_reply`. Clearing `awaitResponse` on
 * resume is LOAD-BEARING — without it the resumed turn ends, `shouldContinue`
 * sees `awaitResponse` still true, and the run re-parks forever.
 */
export function awaitReplyNode(state: NautiloState): Partial<NautiloState> {
  if (!state.awaitResponse) return {};
  const resumed: { reply?: string; fromUserId?: string } | undefined = interrupt({
    type: "await_human_reply",
    targetRoomId: state.awaitRoomId,
    awaitingFromUserIds: state.awaitFromUserIds,
    taskId: state.awaitTaskId,
    taskRunId: state.awaitTaskRunId,
    ownerId: state.awaitOwnerId,
  });

  if (resumed?.reply) {
    return {
      awaitResponse: false,
      messages: [...state.messages, new HumanMessage(resumed.reply)],
    };
  }
  return { awaitResponse: false };
}
