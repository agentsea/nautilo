import { randomUUID } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import type { NautiloState } from "../agent/state";
import { resolveBrowserDecisionModel } from "../tools/browser/browser-snapshot";
import { runWithUsageContext } from "../usage/usage-context";
import { chooseBrowserAction } from "../graph/browser-choice";
import {
  invokeChoice,
  ChoiceRequestError,
  type ChoiceInput,
  type ChoiceResult,
} from "../providers/choice-driver";
import {
  browserDecisionCandidates,
  browserDecisionAdditionalInstructions,
  browserDecisionChoiceInput,
  browserDecisionDriverCall,
  browserDecisionHandoffMessage,
  currentBrowserDecision,
  interpretBrowserDecisionCall,
  isBrowserDecisionObservationCall,
  recordBrowserDecisionEvent,
  type BrowserDecisionState,
} from "../graph/browser-decision";

interface BrowserDecisionDeps {
  fullEncryptionOnlyForState?: (state: NautiloState) => boolean;
  /** Deep-module test seam; production always uses the accounted Choice transport. */
  choose?: (input: ChoiceInput) => Promise<ChoiceResult>;
}

function handoff(state: NautiloState, decision: BrowserDecisionState, reason: string): Partial<NautiloState> {
  const handedOff = { ...decision, phase: "handoff" as const, pending: null, reason };
  return {
    browserDecision: handedOff,
    messages: mergeMessagesPreservingInvariants(state.messages, [browserDecisionHandoffMessage(state.messages, handedOff)]),
  };
}

function recover(
  state: NautiloState,
  decision: BrowserDecisionState,
  cause: string,
): Partial<NautiloState> {
  const recovered = recordBrowserDecisionEvent(decision, cause, "observe");
  return recovered.phase === "handoff"
    ? handoff(state, recovered, recovered.reason ?? "browser_decision_intervention_required")
    : { browserDecision: recovered };
}

export function createBrowserDecisionNode(deps: BrowserDecisionDeps = {}) {
  return async (state: NautiloState, config?: RunnableConfig): Promise<Partial<NautiloState>> => {
    const decision = currentBrowserDecision(state);
    if (!decision || !["observe", "decide"].includes(decision.phase)) return { browserDecision: null };
    if (!decision.recovery) return handoff(state, decision, "browser_decision_recovery_state_unavailable");
    // Absence of a live policy resolver is not permission to send page data.
    if (deps.fullEncryptionOnlyForState?.(state) !== false) return handoff(state, decision, "decision_provider_egress_unavailable");
    if (!config?.signal || config.signal.aborted) return handoff(state, decision, "run_signal_unavailable_or_cancelled");
    const runSignal = config.signal;
    if (state.noProgressPendingCorrection || state.noProgressPendingStop || state.approvalDenied) return handoff(state, decision, "existing_run_intervention");
    const model = resolveBrowserDecisionModel({ turnId: state.turnId, fullEncryptionOnly: false }, decision.modelId);
    if (!model?.decision) {
      return handoff(state, decision, "decision_model_unavailable");
    }
    const observation = decision.observation;
    if (!observation) return handoff(state, decision, "fresh_observation_required");
    let call: { name: string; args: Record<string, unknown> } = {
      name: observation.visual ? "browser_screenshot" : "browser_snapshot",
      args: {},
    };
    let receipt: Record<string, unknown> = { operation: "reobserve" };
    let nextDecision = decision;
    if (decision.phase === "decide") {
      const maxChoices = model.decision.maxChoices;
      const built = browserDecisionCandidates(decision.plan, observation, maxChoices, decision.sequence);
      if (built.reason !== null) return handoff(state, decision, built.reason);
      let planIndex = -1;
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const message = state.messages[index];
        if (AIMessage.isInstance(message) && message.tool_calls?.some((call) =>
          interpretBrowserDecisionCall(call).requestedDelegation)) {
          planIndex = index;
          break;
        }
      }
      const episodeMessages = planIndex < 0 ? [] : state.messages.slice(planIndex + 1);
      const recentActions = episodeMessages.flatMap((message) => {
        if (!AIMessage.isInstance(message)) return [];
        const receipt = message.additional_kwargs["nautilo_browser_decision"] as Record<string, unknown> | undefined;
        if (receipt?.["operation"] !== "choice" || typeof receipt["action"] !== "string") return [];
        const call = message.tool_calls?.[0];
        const result = episodeMessages.find((entry) => ToolMessage.isInstance(entry) && entry.tool_call_id === call?.id && entry.name === call?.name);
        if (!result) return [];
        const status = result.additional_kwargs["nautilo_tool_status"];
        if (result.additional_kwargs["nautilo_browser_failure"] === "browser_observation_stale") {
          return [{ action: receipt["action"], status: "not_executed_stale", evidence: result.content }];
        }
        return [{ action: receipt["action"], ...(status === "success" || status === "error" ? { status } : {}),
          ...(status === "error" || call?.name === "browser_read" || (call?.name === "control_connected_web_operation" && (call.args["command"] as { kind?: string } | undefined)?.kind === "read") ? { evidence: result.content } : {}) }];
      });
      const continuations = built.candidates.filter((candidate) => candidate.sequence && candidate.call);
      const continuation = decision.sequence?.step != null && continuations.length === 1 ? continuations[0] : undefined;
      const additionalInstructions = browserDecisionAdditionalInstructions(observation);
      const started = performance.now();
      try {
        const result = continuation ? null : await runWithUsageContext({
          callType: (state.subagentDepth ?? 0) > 0 ? "subagent" : "chat",
          userId: state.userId ?? null,
          roomId: state.roomId ?? null,
          metadata: { ...(state.agentId ? { agentId: state.agentId } : {}),
            ...(state.turnId ? { turnId: state.turnId } : {}) },
        }, () => chooseBrowserAction(browserDecisionChoiceInput({
          modelId: decision.modelId,
          tenantContext: { ownerId: state.userId },
          signal: runSignal,
          plan: decision.plan,
          observation,
          candidates: built.candidates,
          recentActions,
          lastAction: decision.lastAction,
          sequence: decision.sequence,
          ...(additionalInstructions === undefined ? {} : { additionalInstructions }),
        }), maxChoices, deps.choose ?? invokeChoice));
        if (config.signal.aborted) return handoff(state, decision, "run_cancelled");
        const selected = continuation ?? built.candidates.find(({ id }) => id === result?.selectedId);
        if (!selected) return recover(state, decision, "invalid_choice");
        if (!selected.call) return handoff(state, decision, selected.id === "defer_to_genie" ? "jev_requested_genie" : selected.id);
        call = selected.call;
        if (selected.id === "reobserve") {
          nextDecision = {
            ...decision,
            recovery: { ...decision.recovery, assessNextObservation: true },
          };
        }
        if (selected.sequence) nextDecision = { ...nextDecision, sequence: selected.sequence };
        receipt = { operation: "choice", action: selected.description, selectedId: selected.id,
          ...(selected.sequence ? { sequence: selected.sequence } : {}),
          source: continuation ? "ordered_continuation" : "decision_model",
          ...(result ? { modelId: result.requestedModelId, resolvedModelId: result.resolvedModelId,
            elapsedMs: performance.now() - started, usage: result.usage,
            choiceCalls: result.choiceCalls, screeningRounds: result.screeningRounds,
            ...(result.confidence === undefined ? {} : { confidence: result.confidence }) } : {}) };
      } catch (error) {
        if (error instanceof ChoiceRequestError
          && (error.code === "invalid_response" || error.code === "network_error"
            || (error.code === "provider_error" && error.retryable))) {
          return recover(state, decision, `choice_${error.code}`);
        }
        return handoff(state, decision, error instanceof ChoiceRequestError
          ? `choice_${error.code}${error.status === null ? "" : ` http_status=${error.status}`}` : "choice_unavailable");
      }
    }
    const proposal = { ...browserDecisionDriverCall(call, decision.target), id: `browser-choice:${randomUUID()}`, type: "tool_call" as const };
    return {
      browserDecision: { ...nextDecision, phase: "waiting", reason: null, pending: {
        call: proposal, browserSessionId: observation.browserSessionId,
        observationId: isBrowserDecisionObservationCall(call) ? null : observation.observationId,
      } },
      // This is a proposal only. Normal preflights and post-model admission decide whether it may execute.
      messages: mergeMessagesPreservingInvariants(state.messages, [new AIMessage({
        id: `browser-decision:${randomUUID()}`, content: "", tool_calls: [proposal],
        additional_kwargs: { nautilo_browser_decision: receipt },
      })]),
    };
  };
}
