import { randomUUID } from "node:crypto";
import { canonicalizeComputerUseJson } from "@nautilo/computer-use-contracts";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import type { NautiloState } from "../agent/state";
import { resolveNativeDecisionModel } from "../config/native-decision-model";
import { activeComputerUseHostToolDefinitions, computerUseHostToolDefinition, resolveComputerUseHostToolRequest } from "../config/computer-use-catalogue/host-tool-admission";
import { nativeDecisionHandoffMessage, nativeDecisionResult, outstandingNativeEffects, type NativeDecisionState } from "../graph/native-decision";
import { bindNativeExecutionValue, nativeExecutionStringsBound, nativeExecutionCompletion, nativeExecutionCompletionChoice,
  nativeExecutionInputReferences, nativeFreshRead, projectNativeExecutionObservation, usesNativeReadArguments } from "../graph/native-execution";
import { nativeReconciliationChoices, nativeExecutionReplayKey } from "../graph/native-execution";
import { invokeNativeExecution } from "../providers/native-execution";
import { runWithUsageContext } from "../usage/usage-context";
import { isImageContentBlock } from "../utils/message-modalities";
import { classifyError } from "../utils/errors";
import { ChoiceRequestError } from "../providers/choice";
import { desktopStateObservationSchema, windowStateObservationSchema, computerLaunchReceiptSchema } from "@nautilo/computer-use-contracts/native";
import { nextChoiceContinuation } from "../graph/choice-coverage";

export interface NativeExecutionDeps {
  fullEncryptionOnlyForState?: (state: NautiloState) => boolean;
  interpretNative?: typeof invokeNativeExecution;
}

/** A window read retires that window's old controls, not its sibling window
 * references. Derive those choices from canonical checked results, without a
 * second cache/checkpoint or carrying historical pixels and element tokens.
 * Cross-turn, effect, failed-read and context boundaries end this projection.
 * The Host still resolves each selected native identity at dispatch. */
export function nativeExecutionObservation(state: NautiloState, decision: NativeDecisionState): Record<string, unknown> | null {
  const execution = decision.execution!;
  const observation = execution.observation;
  const window = windowStateObservationSchema.safeParse(observation).data;
  if (!window || !execution.freshRead || execution.mustObserve || outstandingNativeEffects(decision).length || decision.humanTakeover) return observation;
  const windows = new Map<string, ReturnType<typeof desktopStateObservationSchema.parse>["targets"][number]>();
  let current = false;
  for (const message of [...state.messages].reverse()) {
    if (HumanMessage.isInstance(message)) break;
    if (AIMessage.isInstance(message) && message.tool_calls?.some(call =>
      computerUseHostToolDefinition(call.name)?.entry.descriptor.effectClass !== "read")) break;
    if (!ToolMessage.isInstance(message)) continue;
    if (!current && message.tool_call_id !== execution.observationCallId) break;
    current = true;
    const checked = nativeDecisionResult(message);
    if (computerUseHostToolDefinition(message.name ?? "")?.entry.descriptor.effectClass !== "read"
      || checked?.["settlement"] !== "completed") break;
    const payload = checked["result"];
    const siblingRead = windowStateObservationSchema.safeParse(payload).data;
    if (siblingRead) {
      if (siblingRead.target.context !== window.target.context || siblingRead.outcome.externalInterference === "user_input") break;
      continue;
    }
    const page = desktopStateObservationSchema.safeParse(payload).data;
    if (!page || page.context !== window.target.context || page.outcome.externalInterference === "user_input") break;
    for (const row of page.targets) if (row.target.reference !== window.target.reference && !windows.has(row.target.reference)) {
      windows.set(row.target.reference, row);
    }
  }
  return windows.size ? { ...observation, availableWindows: [...windows.values()] } : observation;
}
export async function nativeExecutionNode(state: NautiloState, decision: NativeDecisionState, deps: NativeExecutionDeps, config?: RunnableConfig, completionNominated = false): Promise<Partial<NautiloState>> {
  const execution = decision.execution!;
  const retainedRead = nativeFreshRead(execution.lastRead);
  let telemetry: Record<string, unknown> | null = null;
  const handoff = (reason: string, question: string | null = null): Partial<NautiloState> => {
    const next: NativeDecisionState = { ...decision, phase: "handoff", pending: null, reason, execution: { ...execution, question } };
    return { nativeDecision: next, messages: mergeMessagesPreservingInvariants(state.messages, [
      ...(telemetry ? [new AIMessage({ id: `native-route:${randomUUID()}`, content: "", additional_kwargs: { nautilo_native_decision: telemetry } })] : []),
      nativeDecisionHandoffMessage(next),
    ]) };
  };
  if (decision.humanTakeover) return handoff("human_takeover");
  if (deps.fullEncryptionOnlyForState?.(state) !== false) return handoff("decision_provider_egress_unavailable");
  if (!config?.signal || config.signal.aborted) return handoff("run_signal_unavailable_or_cancelled");
  if (state.noProgressPendingCorrection || state.noProgressPendingStop || state.approvalDenied) return handoff("existing_run_intervention");
  const window = execution.freshRead && !execution.mustObserve ? windowStateObservationSchema.safeParse(execution.observation).data : undefined;
  if (window && retainedRead?.tool === "computer_observe" && retainedRead.arguments["operation"] === "window_state"
    && JSON.stringify(canonicalizeComputerUseJson(window.target)) !== JSON.stringify(canonicalizeComputerUseJson(retainedRead.arguments["target"]))) {
    return handoff("native_observation_target_changed");
  }
  const choiceModelId = decision.modelId;
  if (resolveNativeDecisionModel({ turnId: state.turnId, fullEncryptionOnly: false }, choiceModelId)?.id !== choiceModelId)
    return handoff("decision_model_unavailable");
  const definitions = activeComputerUseHostToolDefinitions().filter(tool => execution.tools.includes(tool.name) && state.toolNames?.includes(tool.name));
  if (!definitions.length) return handoff("native_capabilities_unavailable");
  // Verification of an already acquired scope is code-owned. Do not spend an
  // interpretation call rebuilding the exact prior read after each mutation.
  const launch = execution.mustObserve ? computerLaunchReceiptSchema.safeParse(execution.observation).data : undefined;
  const readback = launch?.window && launch.verification === "required"
    ? { tool: "computer_observe", arguments: { operation: "window_state", target: launch.window } }
    : launch?.app.target ? { tool: "computer_observe", arguments: { operation: "application_windows", target: launch.app.target } }
      : retainedRead;
  if (execution.mustObserve && !execution.readbackFailed && readback) {
    const read = definitions.find(tool => tool.name === readback.tool && tool.entry.descriptor.effectClass === "read");
    const admitted = read && resolveComputerUseHostToolRequest(read.name, readback.arguments);
    if (!admitted) return handoff("execution_readback_unavailable");
    const proposal = { id: `native-readback:${randomUUID()}`, type: "tool_call" as const, name: read.name, args: admitted.arguments };
    return { nativeDecision: { ...decision, phase: "waiting", pending: proposal, reason: null },
      messages: mergeMessagesPreservingInvariants(state.messages, [new AIMessage({ content: "", tool_calls: [proposal],
        additional_kwargs: { nautilo_native_decision: { role: "runtime", operation: "verify_effect", modelCalls: 0 } } })]) };
  }
  const inventory = execution.freshRead && !execution.mustObserve && !outstandingNativeEffects(decision).length
    ? desktopStateObservationSchema.safeParse(execution.observation).data : undefined;
  if (inventory?.continuation && definitions.some(tool => tool.name === "computer_observe")) {
    const continuation = nextChoiceContinuation({ complete: inventory.completeness === "complete",
      continuation: { key: `${inventory.context}:${inventory.continuation.reference}`,
        request: { operation: "desktop_state", continuation: { ...inventory.continuation, context: inventory.context } } },
    }, execution.continued ?? []);
    if (continuation.kind === "stalled") return handoff("native_inventory_continuation_stalled");
    if (continuation.kind === "continue") {
      const admitted = resolveComputerUseHostToolRequest("computer_observe", continuation.request);
      if (!admitted) return handoff("native_inventory_continuation_unavailable");
      const proposal = { id: `native-continue:${randomUUID()}`, type: "tool_call" as const, name: "computer_observe", args: admitted.arguments };
      return { nativeDecision: { ...decision, phase: "waiting", pending: proposal, reason: null,
        execution: { ...execution, continued: continuation.attempted } },
        messages: mergeMessagesPreservingInvariants(state.messages, [new AIMessage({ id: `native-continue:${randomUUID()}`, content: "",
          tool_calls: [proposal], additional_kwargs: { nautilo_native_decision: { role: "runtime", operation: "continue_inventory", modelCalls: 0 } } })]),
      };
    }
  }
  const resultMessage = state.messages.find(message => ToolMessage.isInstance(message) && message.tool_call_id === execution.observationCallId);
  const images = resultMessage && Array.isArray(resultMessage.content) ? resultMessage.content.filter(isImageContentBlock) : [];
  // Images are evidence for a selected interpretation route, not a condition
  // for text-grounded Choice actions or code-owned readback. Existing telemetry
  // imageCount records available images; per-model imageBytes records transport.
  const started = performance.now();
  const currentRoots = () => ({ request: decision.execution!.request, values: decision.plan.values, observation: nativeExecutionObservation(state, decision),
    ...(decision.execution!.lastRead ? { readArguments: nativeFreshRead(decision.execution!.lastRead)!.arguments } : {}) });
  const roots = currentRoots();
  const sourceRevision = JSON.stringify(roots);
  let providerReturned = false;
  try {
    const selected = await runWithUsageContext({ callType: "chat", userId: state.userId ?? null, roomId: state.roomId ?? null,
      metadata: { agentId: state.agentId, turnId: state.turnId, nativeDecisionRole: "execution" } },
    () => (deps.interpretNative ?? invokeNativeExecution)({ modelId: decision.controller?.modelId ?? "",
      decisionModelId: decision.modelId, signal: config.signal!,
      roots,
      completion: nativeExecutionCompletionChoice(decision),
      completionNominated,
      reconciliation: nativeReconciliationChoices(decision),
      onProgress: progress => { telemetry = { role: "execution", operation: "select", modelId: decision.controller?.modelId ?? decision.modelId,
        imageCount: images.length, ...progress }; },
      capabilities: definitions.map(tool => ({ name: tool.name, description: tool.entry.projection.modelDescription,
        schema: tool.entry.publicSchemas.input.jsonSchema, effectClass: tool.entry.descriptor.effectClass })),
      state: { request: execution.request, goal: decision.plan.goal, constraints: decision.plan.constraints,
        values: decision.plan.values, observation: projectNativeExecutionObservation(roots.observation),
        lastRead: retainedRead ? { tool: retainedRead.tool, arguments: { $valueRef: { source: "readArguments", path: [] } } } : null,
        currentRoute: { lastReadOperation: retainedRead?.arguments["operation"] ?? null,
          observedOperation: roots.observation?.["operation"] ?? null,
          observedEvidenceKind: roots.observation?.["evidence"] && typeof roots.observation["evidence"] === "object"
            ? (roots.observation["evidence"] as Record<string, unknown>)["kind"] ?? null : null },
        recentActions: decision.history, mustObserve: execution.mustObserve, readbackFailed: execution.readbackFailed ?? false,
        continuation: { observationGeneration: decision.generation, freshRead: execution.freshRead,
          question: execution.question, reason: decision.reason, unchangedOrFailedTransitions: decision.recovery.events },
        unresolvedEffects: outstandingNativeEffects(decision).map(entry => entry.receipt) }, images,
    }));
    providerReturned = true;
    const reply = selected.decision;
    telemetry = { role: "execution", operation: reply.kind, modelId: selected.modelId,
      imageCount: images.length, elapsedMs: performance.now() - started, usage: selected.usage, modelCalls: selected.modelCalls, modelUsage: selected.modelUsage };
    if (config.signal.aborted) return handoff("run_cancelled");
    // Admission may be withdrawn while a Choice or interpreter call is in
    // flight. Recheck the exact retained model before any new proposal or
    // completion; code-owned post-effect readback above is unaffected.
    if (decision.modelId !== choiceModelId
      || resolveNativeDecisionModel({ turnId: state.turnId, fullEncryptionOnly: false }, choiceModelId)?.id !== choiceModelId)
      return handoff("decision_model_unavailable");
    if (sourceRevision !== JSON.stringify(roots) || sourceRevision !== JSON.stringify(currentRoots())) return handoff("execution_sources_changed");
    const update = (next: NativeDecisionState, message: AIMessage) => ({ nativeDecision: next,
      messages: mergeMessagesPreservingInvariants(state.messages, [message]) });
    if (reply.kind === "genie") {
      return handoff(`execution_${reply.reason}`, reply.question);
    }
    if (reply.kind === "reconcile") {
      const candidate = nativeReconciliationChoices(decision).find(entry => entry.callId === reply.callId);
      if (!candidate || !execution.observationCallId) return handoff("execution_reconciliation_not_grounded");
      const next: NativeDecisionState = { ...decision, phase: "interpret", reason: null, pending: null,
        unresolved: decision.unresolved.map(entry => entry.callId === reply.callId ? { ...entry,
          resolution: { generation: decision.generation, observationCallId: execution.observationCallId!, basis: candidate.basis } } : entry),
        execution: { ...execution, ...(candidate.basis === "scoped_text_delta" && execution.textMutation
          ? { textMutation: { ...execution.textMutation, settlement: "completed" } } : {}) },
      };
      return update(next, new AIMessage({ content: "", additional_kwargs: { nautilo_native_decision: {
        ...telemetry, operation: "reconcile_effect", basis: candidate.basis, generation: decision.generation,
      } } }));
    }
    if (reply.kind === "complete") {
      if (!nativeExecutionCompletion(reply, decision)) return handoff("execution_completion_not_verified");
      return update({ ...decision, phase: "complete", reason: null, pending: null }, new AIMessage({ id: `native-complete:${randomUUID()}`,
        content: reply.summary, additional_kwargs: { nautilo_native_decision: { ...telemetry, checkedPredicates: reply.checks.length } } }));
    }
    const definition = definitions.find(tool => tool.name === reply.tool);
    if (!definition) return handoff("execution_tool_not_exposed");
    const read = definition.entry.descriptor.effectClass === "read";
    if (!read && (execution.mustObserve || outstandingNativeEffects(decision).length)) return handoff("execution_fresh_verification_required");
    if (!read && usesNativeReadArguments(reply.arguments)) return handoff("execution_historical_input_not_authority");
    const args = bindNativeExecutionValue(reply.arguments, roots);
    if (!nativeExecutionStringsBound(reply.arguments, args, definition.entry.publicSchemas.input.jsonSchema)) return handoff("execution_unbound_input");
    const admitted = resolveComputerUseHostToolRequest(reply.tool, args);
    if (!admitted) return handoff("execution_operation_not_admitted");
    if (!read && decision.unresolved.some(entry => entry.replayKey === nativeExecutionReplayKey(
      { name: reply.tool, args: admitted.arguments }, execution.observation))) return handoff("execution_uncertain_effect_replay_forbidden");
    const proposal = { id: `native-execute:${randomUUID()}`, type: "tool_call" as const, name: reply.tool, args: admitted.arguments };
    const boundInputs = [...new Map([...(execution.boundInputs ?? []), ...nativeExecutionInputReferences(reply.arguments)]
      .map(ref => [JSON.stringify(ref), ref])).values()];
    return update({ ...decision, phase: "waiting", pending: proposal, reason: null, execution: { ...execution, boundInputs } }, new AIMessage({
      id: `native-decision:${randomUUID()}`, content: "", tool_calls: [proposal], additional_kwargs: { nautilo_native_decision: telemetry },
    }));
  } catch (error) {
    const category = error instanceof ChoiceRequestError ? error.code : classifyError(error).category;
    // Preserve attempt accounting and the existing sanitized classification.
    // Never copy provider bodies, echoed content, or headers into model history.
    telemetry = { ...(telemetry ?? { role: "execution", operation: "error", modelId: decision.controller?.modelId ?? decision.modelId, usage: null }),
      elapsedMs: performance.now() - started, errorCategory: category };
    return handoff(config.signal.aborted ? "run_cancelled"
      : error instanceof ChoiceRequestError ? `execution_choice_${error.code}`
      : !providerReturned && category !== "UNKNOWN" ? `execution_provider_${category.toLowerCase()}` : "execution_interpretation_unavailable");
  }
}
