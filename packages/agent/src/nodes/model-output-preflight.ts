import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { NautiloState } from "../agent/state";
import { applyToolResultsToStreaks, buildNoProgressKey, resetStreakForKey, NoProgressError } from "../graph/no-progress";
import { resolveGraphExecutionPolicy } from "../graph/execution-policy";

import { currentResearchContextRecovery } from "../tools/security/research-context-rollover";
import { securityResearchContinuation } from "../tools/security/research-continuation";
import { researchWorkFinalizationError } from "../tools/security/research-work-context";

const MALFORMED_CALL_FEEDBACK = "Error: MALFORMED_TOOL_ARGUMENTS. This request was not executed because its arguments were not valid JSON. Submit the intended request again with one complete JSON object matching the tool schema. Do not repeat successful sibling calls.";

/**
 * Provider parsers retain malformed requests separately from callable tools.
 * Pair each with an explicit rejection before approval, rather than treating
 * an empty visible message as a completed answer. The empty argument object
 * is a provider-history placeholder only: rejected IDs can never execute.
 */
export function modelOutputPreflightNode(state: NautiloState): Partial<NautiloState> {
  const last = state.messages.at(-1);
  if (!last || !AIMessage.isInstance(last) || !last.invalid_tool_calls?.length) {
    let repairedStreaks = state.noProgressStreaks ?? new Map();
    if (last && AIMessage.isInstance(last)) {
      const rejectedIds = new Set(state.modelRejectedToolCallIds ?? []);
      const repairedNames = new Set(last.tool_calls?.map((call) => call.name));
      for (const message of state.messages) {
        if (ToolMessage.isInstance(message) && rejectedIds.has(message.tool_call_id) && message.name) repairedNames.add(message.name);
      }
      for (const toolName of repairedNames) {
        repairedStreaks = resetStreakForKey(repairedStreaks, buildNoProgressKey({
          toolName, args: {}, status: "error", errorContent: MALFORMED_CALL_FEEDBACK,
        }));
      }
    }
    const prior = state.messages.at(-2);
    const progress = prior && ToolMessage.isInstance(prior) && prior.additional_kwargs?.["nautilo_tool_status"] === "success";
    const streaks = progress ? applyToolResultsToStreaks(repairedStreaks,
      [{ toolName: "security_research_completion", args: {}, status: "success" }],
      resolveGraphExecutionPolicy().repeatedFailureLimit).streaks : repairedStreaks;
    const researchContinuation = state.taskRun && state.toolWhitelist?.includes("security_scan")
      ? securityResearchContinuation(state.messages) : null;
    const feedback = last && AIMessage.isInstance(last) && !last.tool_calls?.length
      && state.taskRun && !state.awaitResponse && state.toolWhitelist?.includes("security_scan")
      ? (currentResearchContextRecovery(state)
        ? "Historical context recovery is still active. Read the runtime-provided pending references and continuation cursors before finishing. Follow the current recovery instruction for saving notes or synthesizing an already finalized report; continue this same Task."
        : researchContinuation === null ? null : researchWorkFinalizationError(state) ?? researchContinuation) : null;
    if (feedback) {
      const transition = applyToolResultsToStreaks(streaks,
        [{ toolName: "security_research_completion", args: {}, status: "error", errorContent: "Requested research remains incomplete" }],
        resolveGraphExecutionPolicy().repeatedFailureLimit);
      if (transition.action.kind === "stop_no_progress") throw new NoProgressError(transition.action.key);
      return { modelRejectedToolCallIds: [], researchContinuationRequired: true,
        messages: [...state.messages, new HumanMessage({ content: feedback, additional_kwargs: { nautilo_research_continuation: true } })],
        noProgressStreaks: transition.streaks,
        ...(transition.action.kind === "inject_corrective" ? { noProgressPendingCorrection: transition.action.key } : {}) };
    }
    return { modelRejectedToolCallIds: [], researchContinuationRequired: false,
      ...(progress || repairedStreaks !== state.noProgressStreaks && state.noProgressStreaks !== undefined ? { noProgressStreaks: streaks } : {}) };

  }
  const usedIds = new Set(last.tool_calls?.map((call) => call.id));
  const rejected = last.invalid_tool_calls.map((call) => {
    const id = call.id && !usedIds.has(call.id) ? call.id : randomUUID();
    usedIds.add(id);
    return { id, name: call.name || "invalid_tool_call", args: {}, type: "tool_call" as const };
  });
  // Do not send malformed raw JSON back to the provider or expose it in logs.
  const additionalKwargs = Object.fromEntries(Object.entries(last.additional_kwargs)
    .filter(([key]) => key !== "tool_calls" && key !== "function_call"));
  const message = new AIMessage({
    ...(last.id === undefined ? {} : { id: last.id }),
    content: last.content,
    additional_kwargs: additionalKwargs,
    response_metadata: last.response_metadata,
    ...(last.usage_metadata === undefined ? {} : { usage_metadata: last.usage_metadata }),
    tool_calls: [...(last.tool_calls ?? []), ...rejected],
    invalid_tool_calls: [],
  });
  const replies = rejected.map((call) => new ToolMessage({
    tool_call_id: call.id,
    name: call.name,
    content: MALFORMED_CALL_FEEDBACK,
    additional_kwargs: { nautilo_tool_status: "error" },
  }));
  const update: Partial<NautiloState> = {
    messages: mergeMessagesPreservingInvariants([...state.messages.slice(0, -1), message], replies),
    modelRejectedToolCallIds: rejected.map((call) => call.id),
    researchContinuationRequired: false,
  };
  // Mixed batches are counted once by the tools node after valid siblings
  // finish. An all-invalid batch never reaches tools, so count it here.
  if (!last.tool_calls?.length) {
    const transition = applyToolResultsToStreaks(state.noProgressStreaks ?? new Map(),
      rejected.map((call) => ({ toolName: call.name, args: call.args, status: "error" as const, errorContent: MALFORMED_CALL_FEEDBACK })),
      resolveGraphExecutionPolicy().repeatedFailureLimit);
    if (transition.action.kind === "stop_no_progress") throw new NoProgressError(transition.action.key);
    update.noProgressStreaks = transition.streaks;
    if (transition.action.kind === "inject_corrective") update.noProgressPendingCorrection = transition.action.key;
  }
  return update;
}
