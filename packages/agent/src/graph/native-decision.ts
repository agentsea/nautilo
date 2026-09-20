import { createHash, randomUUID } from "node:crypto";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { canonicalizeComputerUseJson } from "@nautilo/computer-use-contracts";
import { windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";
import type { z } from "zod";
import type { NautiloState } from "../agent/state";
import { projectComputerUseHostToolResult, resolveComputerUseHostToolRequest } from "../config/computer-use-catalogue/host-tool-admission";
import { durableComputerResultText } from "../tools/computer/model-result-projector";
import { BROWSER_DECISION_CONTROL_IDS } from "./browser-choice";
import { nativeDecisionHostArguments, parseNativeDecisionPlan, type NativeDecisionPlan } from "./native-decision-plan";
import { resolveGraphExecutionPolicy } from "./execution-policy";
import type { ChoiceInput } from "../providers/choice";

type Observation = z.infer<typeof windowStateObservationSchema>;
type Control = NonNullable<Observation["controlCollection"]>["controls"][number];
export interface NativeDecisionState {
  turnId: string;
  modelId: string;
  plan: NativeDecisionPlan;
  observeArgs: Record<string, unknown>;
  observation: Observation | null;
  phase: "observe" | "decide" | "waiting" | "handoff";
  pending: (ToolCall & { id: string }) | null;
  reason: string | null;
  generation: number;
  /** Optional for old checkpoints. A retained model is revalidated, never silently replaced. */
  controller?: { modelId: string; attemptedGeneration: number; active: boolean };
  history: Array<{ action: string; settlement: string; evidence: unknown; repetitions?: number }>;
  /** Retained across observation and redelegation; fresh handles do not settle an effect. */
  unresolved: Array<{ callId: string; operation: unknown; receipt: unknown; replayKey: string }>;
  recovery: { limit: number; events: number; transitions: string[]; before: string | null };
}
export interface NativeDecisionCandidate {
  id: string;
  description: string;
  call: Pick<ToolCall, "name" | "args"> | null;
  controlId?: string;
  replayKey?: string;
}
export function currentNativeDecision(state: NautiloState): NativeDecisionState | null {
  return state.nativeDecision?.turnId === state.turnId ? state.nativeDecision : null;
}

/** Model context contains semantic rows, never executable handles or driver bytes. */
export function nativeDecisionEvidence(observation: Observation) {
  return {
    window: observation.evidence,
    completeness: observation.completeness,
    degraded: observation.degraded,
    verification: observation.verification,
    collection: observation.controlCollection ? {
      ...observation.controlCollection,
      controls: observation.controlCollection.controls.map(({ target: _target, ...control }) => control),
    } : null,
  };
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Object order is transport formatting; array order and exact values are identity. */
function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(canonicalizeComputerUseJson(left)) === JSON.stringify(canonicalizeComputerUseJson(right));
  } catch { return false; }
}
function replayOperationFor(operation: Record<string, unknown>) {
  const { target: _target, deliveryMode: _deliveryMode, delayMs: _delayMs, ...logicalOperation } = operation;
  return operation["kind"] === "type_text" || operation["kind"] === "set_value"
    ? { kind: "write_value", value: operation["text"] ?? operation["value"] } : logicalOperation;
}
export function nativeDecisionCandidates(decision: NativeDecisionState): NativeDecisionCandidate[] {
  const observation = decision.observation;
  if (!observation) return [];
  const controls = observation.controlCollection?.controls ?? [];
  const candidates: NativeDecisionCandidate[] = [];
  const seen = new Set<string>();
  const add = (purpose: string, operation: Record<string, unknown>, control?: Control, valueName?: string) => {
    const admitted = resolveComputerUseHostToolRequest("computer_do", { operation });
    if (!admitted) return;
    const key = JSON.stringify(canonicalizeComputerUseJson(admitted.arguments));
    if (seen.has(key)) return;
    seen.add(key);
    const { target: _target, ...semanticOperation } = operation;
    const describedOperation = valueName === undefined ? semanticOperation : {
      ...Object.fromEntries(Object.entries(semanticOperation).filter(([key]) => key !== "text" && key !== "value")),
      suppliedValue: valueName,
    };
    // Input replay is identified without snapshot handles. An uncertain text,
    // key or menu operation cannot be laundered through a new target. Clicks
    // retain semantic lineage so an unrelated recovery control remains usable.
    const lineage: unknown[] = [];
    const visited = new Set<string>();
    let row = control;
    while (row && !visited.has(row.id)) {
      visited.add(row.id);
      lineage.push({ role: row.role, ...(row.label ? { label: row.label } : {}) });
      row = controls.find((candidate) => candidate.id === row?.parent);
    }
    const replayOperation = replayOperationFor(operation);
    const replayLineage = operation["kind"] === "click" ? lineage : null;
    const replayKey = digest(canonicalizeComputerUseJson([replayOperation, replayLineage]));
    if (decision.unresolved.some((entry) => {
      if (entry.replayKey === replayKey) return true;
      // Older checkpoints hashed insertion order. Reconstruct their original
      // hash from the retained operation without discarding click lineage.
      if (!entry.operation || typeof entry.operation !== "object" || Array.isArray(entry.operation)) return false;
      const retainedOperation = replayOperationFor(entry.operation as Record<string, unknown>);
      return sameJson(retainedOperation, replayOperation)
        && entry.replayKey === digest([retainedOperation, replayLineage]);
    })) return;
    candidates.push({
      id: `a${decision.generation}_${candidates.length}`,
      description: JSON.stringify({ purpose, operation: describedOperation,
        ...(control ? { control: control.id } : { target: "planned exact target or current window" }) }),
      call: { name: "computer_do", args: admitted.arguments },
      replayKey,
      ...(control ? { controlId: control.id } : {}),
    });
  };
  for (const action of decision.plan.actions) {
    const valueField = action.operation["kind"] === "type_text" ? "text"
      : action.operation["kind"] === "set_value" ? "value" : null;
    const bind = (operation: Record<string, unknown>, valueName?: string) => {
      if (action.target === "exact") add(action.purpose, operation, undefined, valueName);
      else if (action.target === "window") add(action.purpose, { ...operation, target: observation.target }, undefined, valueName);
      else for (const control of controls) {
        // Roles describe evidence, not permission. The driver determines support.
        if (control.target && control.enabled !== false) add(action.purpose, { ...operation, target: control.target }, control, valueName);
      }
    };
    if (valueField && !Object.hasOwn(action.operation, valueField) && action.target !== "exact") {
      for (const [name, value] of Object.entries(decision.plan.values)) bind({ ...action.operation, [valueField]: value }, name);
    } else {
      const valueName = valueField ? Object.entries(decision.plan.values).find(([, value]) => value === action.operation[valueField])?.[0] : undefined;
      bind(action.operation, valueName);
    }
  }
  for (const id of BROWSER_DECISION_CONTROL_IDS) candidates.push({
    id, description: id === "completion_ready" ? "Whole goal appears reached; return evidence for Genie verification."
      : id === "reobserve" ? "Read fresh state without repeating a mutation."
        : id === "needs_visual_evidence" ? "Target or effect needs pixels; return to the vision-capable Genie."
          : id === "needs_input" ? "Required exact argument is missing; return to Genie."
            : "Return to Genie for interpretation, ambiguity or recovery.",
    call: id === "reobserve" ? { name: "computer_observe", args: decision.observeArgs } : null,
  });
  candidates.push({ id: "request_replan", description: "The workflow or action menu cannot satisfy the goal. Return the retained state to Genie to redefine it.", call: null });
  if (decision.controller?.active) {
    candidates.push({ id: "rebuild_choices", description: "The menu is incomplete or stale. Read fresh controls, rebuild bound choices, then return selection automatically.",
      call: { name: "computer_observe", args: decision.observeArgs } });
    if (decision.controller.modelId !== decision.modelId) candidates.push({ id: "return_to_selector", description: "Current structured evidence is sufficient; return selection to the classifier without executing or observing again.", call: null });
  }
  return candidates;
}

/** Repeat selection validation at ordinary admission and dispatch, not just prompting. */
export function nativeDecisionDispatchError(state: NautiloState, call: ToolCall): string | null {
  const decision = currentNativeDecision(state);
  const pending = decision?.pending;
  if (!decision || !pending || pending.id !== call.id) return null;
  if (decision.phase !== "waiting" || pending.name !== call.name
    || !sameJson(pending.args, call.args)) return "native_decision_proposal_changed";
  if (call.name === "computer_observe") return null;
  return nativeDecisionCandidates(decision).some((candidate) => candidate.call?.name === call.name
    && sameJson(candidate.call.args, call.args)) ? null : "native_decision_action_not_current_or_replay_fenced";
}

/** Each screening request sees its rows and ancestors, not the whole collection again. */
export function projectNativeDecisionScreen(input: ChoiceInput, decision: NativeDecisionState, candidates: readonly NativeDecisionCandidate[]): ChoiceInput {
  if (!input.choices.some((choice) => choice.id === "none_in_group") || !decision.observation?.controlCollection) return input;
  const rows = decision.observation.controlCollection.controls;
  const ids = new Set(input.choices.map((choice) => choice.id));
  const selected = candidates.filter((candidate) => ids.has(candidate.id));
  // Window/exact operations can depend on any row. Preserve that evidence.
  if (selected.some((candidate) => candidate.controlId === undefined)) return input;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const keep = new Set(selected.flatMap((candidate) => candidate.controlId ? [candidate.controlId] : []));
  for (const id of keep) {
    const row = byId.get(id);
    if (!row) return input;
    if (row.parent) keep.add(row.parent);
  }
  const evidence = nativeDecisionEvidence(decision.observation);
  return { ...input, state: { ...(input.state as Record<string, unknown>), observation: {
    ...evidence, collection: { ...evidence.collection,
      controls: evidence.collection!.controls.filter((row) => keep.has(row.id)),
      projection: { kind: "screening_group", total: rows.length, included: keep.size },
    },
  } } };
}

export function nativeDecisionHandoffMessage(decision: NativeDecisionState): SystemMessage {
  return new SystemMessage({ id: `native-handoff:${randomUUID()}`, content: JSON.stringify({
    kind: "native_decision_handoff", reason: decision.reason, goal: decision.plan.goal,
    instruction: "Inspect current evidence and independently verify completion. Use ordinary Computer Use for visual grounding or diagnosis. Repair missing exact arguments before redelegating remaining work. A fresh target is not proof that an uncertain mutation did not happen; do not replay it.",
    ...(decision.unresolved.length ? { unresolved: decision.unresolved } : {}),
  }) });
}
function handoff(decision: NativeDecisionState, reason: string): NativeDecisionState {
  return { ...decision, phase: "handoff", pending: null, reason };
}
function addHistory(decision: NativeDecisionState, entry: NativeDecisionState["history"][number]) {
  const history = [...decision.history];
  const last = history.at(-1);
  if (last && last.action === entry.action && last.settlement === entry.settlement
    && JSON.stringify(last.evidence) === JSON.stringify(entry.evidence)) {
    history[history.length - 1] = { ...last, repetitions: (last.repetitions ?? 1) + 1 };
  } else history.push(entry);
  return history;
}

/** Only independently catalogue-checked Host results may drive the fast loop. */
export function nativeDecisionResult(result: ToolMessage): Record<string, unknown> | null {
  const raw = durableComputerResultText(result);
  if (!raw || !result.name) return null;
  try {
    const checked = projectComputerUseHostToolResult(result.name, JSON.parse(raw));
    return checked ? JSON.parse(checked) as Record<string, unknown> : null;
  } catch { return null; }
}

export function settleNativeDecision(state: NautiloState, calls: readonly ToolCall[], results: readonly ToolMessage[], remaining: readonly ToolCall[], modelId: string): NativeDecisionState | null {
  const current = currentNativeDecision(state);
  const call = calls[0]; const result = results[0];
  if (remaining.length || calls.length !== 1 || results.length !== 1 || !call?.id || !result
    || result.tool_call_id !== call.id || result.name !== call.name) return current ? handoff(current, "ordinary_genie_control") : null;
  const continues = current?.phase === "waiting" && current.pending?.id === call.id
    && current.pending.name === call.name && sameJson(current.pending.args, call.args);
  const plan = parseNativeDecisionPlan(call.name, call.args);
  const source = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
  const starts = plan && modelId && state.turnId && source?.tool_calls?.length === 1 && source.tool_calls[0]?.id === call.id;
  if (!continues && !starts) return current ? handoff(current, "ordinary_genie_control") : null;
  let next: NativeDecisionState = starts ? {
    turnId: state.turnId, modelId, plan,
    observeArgs: nativeDecisionHostArguments(call.name, call.args) as Record<string, unknown>,
    observation: null, phase: "decide", pending: null, reason: null, generation: (current?.generation ?? 0) + 1,
    history: current?.history ?? [], unresolved: current?.unresolved ?? [],
    recovery: { limit: resolveGraphExecutionPolicy().browserDecisionInterventionLimit, events: 0, transitions: [], before: null },
  } : { ...current!, pending: null };
  const checked = nativeDecisionResult(result);
  if (!checked) {
    if (call.name === "computer_do") next.unresolved = [...next.unresolved, { callId: call.id, operation: call.args["operation"], receipt: { settlement: "unrecognized_result" }, replayKey: "unclassified" }];
    return handoff(next, "checked_host_result_unavailable");
  }
  const payload = checked["result"] as Record<string, unknown>;
  const settlement = String(checked["settlement"]);
  if (call.name === "computer_observe") {
    const parsed = windowStateObservationSchema.safeParse(payload);
    if (settlement !== "completed" || !parsed.success || !parsed.data.controlCollection || parsed.data.evidence === null) return handoff(next, "native_control_collection_unavailable");
    if (!sameJson(parsed.data.target, call.args["target"])) return handoff(next, "native_observation_target_changed");
    const last = next.history.at(-1);
    const retained = last?.evidence as Record<string, unknown> | undefined;
    if (last && retained && !Object.hasOwn(retained, "observed") && next.observation) {
      const before = nativeDecisionEvidence(next.observation);
      const after = nativeDecisionEvidence(parsed.data);
      const previousRows = new Set(before.collection?.controls.map((row) => JSON.stringify(row)));
      const currentRows = new Set(after.collection?.controls.map((row) => JSON.stringify(row)));
      next.history = [...next.history.slice(0, -1), { ...last, evidence: { ...retained,
        observed: { window: after.window,
          addedOrChanged: after.collection?.controls.filter((row) => !previousRows.has(JSON.stringify(row))) ?? [],
          removedOrChanged: before.collection?.controls.filter((row) => !currentRows.has(JSON.stringify(row))) ?? [],
          completeness: after.collection?.completeness ?? "unavailable" },
      } }];
    }
    next = { ...next, observation: parsed.data, observeArgs: { ...next.observeArgs, target: parsed.data.target }, generation: next.generation + 1,
      ...(next.controller ? { controller: { ...next.controller, active: false } } : {}) };
    if (next.unresolved.some((entry) => entry.replayKey === "unclassified")) return handoff(next, "unresolved_effect_requires_verification");
    const after = digest(nativeDecisionEvidence(parsed.data));
    const transition = digest([next.recovery.before, next.history.at(-1), after]);
    const repeated = next.recovery.transitions.includes(transition);
    const noProgress = next.recovery.before === after || repeated;
    const events = noProgress ? next.recovery.events + 1 : 0;
    next.recovery = { ...next.recovery, events, before: after,
      transitions: repeated ? next.recovery.transitions : [...next.recovery.transitions, transition] };
    return events >= next.recovery.limit ? handoff(next, "native_decision_no_progress") : { ...next, phase: "decide", reason: null };
  }
  const outcome = payload["outcome"] as Record<string, unknown> | undefined;
  const receipt = { settlement, ...(payload["completionCertainty"] === undefined ? {} : { completionCertainty: payload["completionCertainty"] }), ...(outcome ? { outcome } : {}),
    ...(payload["providerAction"] ? { providerAction: payload["providerAction"] } : {}) };
  const unknown = settlement === "unknown_completion" || payload["completionCertainty"] === "unknown_completion"
    || payload["completionCertainty"] === "partially_completed" || outcome?.["stateChangeCertainty"] === "unknown";
  const authored = source?.additional_kwargs["nautilo_native_decision"] as { action?: string } | undefined;
  const operation = call.args["operation"] as Record<string, unknown>;
  const { target: _target, ...semanticOperation } = operation;
  const selectedControl = next.observation?.controlCollection?.controls.find((control) => sameJson(control.target, operation["target"]));
  const { target: _controlTarget, ...controlEvidence } = selectedControl ?? {};
  next.history = addHistory(next, { action: JSON.stringify({ operation: semanticOperation,
    ...(authored?.action ? { selection: authored.action } : {}) }), settlement,
    evidence: { receipt, source: { window: next.observation ? nativeDecisionEvidence(next.observation).window : null,
      control: selectedControl ? controlEvidence : null } } });
  if (unknown) {
    const candidate = current ? nativeDecisionCandidates(current).find((entry) => entry.call?.name === call.name
      && sameJson(entry.call.args, call.args)) : undefined;
    next.unresolved = [...next.unresolved, { callId: call.id, operation: call.args["operation"], receipt, replayKey: candidate?.replayKey ?? "unclassified" }];
  }
  if (["revoked", "cancelled", "fenced"].includes(settlement)) return handoff(next, settlement);
  if (outcome?.["externalInterference"] === "user_input") return handoff(next, "human_takeover");
  // Refused actions may recover. Unknown effects stay fenced from replay across
  // fresh handles; different recovery actions and observations remain available.
  if (settlement !== "completed" && !unknown && payload["completionCertainty"] !== "not_completed") return handoff(next, "unclassified_action_failure");
  const window = payload["window"];
  const appeared = payload["postObservation"] as { window?: { target?: unknown } } | undefined;
  if (window && call.args["operation"] && (call.args["operation"] as Record<string, unknown>)["kind"] === "launch_app") next.observeArgs = { operation: "window_state", target: window };
  else if (appeared?.window?.target) next.observeArgs = { operation: "window_state", target: appeared.window.target };
  return { ...next, phase: "observe", reason: null };
}
