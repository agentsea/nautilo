import { createHash, randomUUID } from "node:crypto";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { canonicalizeComputerUseJson } from "@nautilo/computer-use-contracts";
import { windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";
import type { z } from "zod";
import type { NautiloState } from "../agent/state";
import { computerUseHostToolDefinition, projectComputerUseHostToolResult, resolveComputerUseHostToolRequest } from "../config/computer-use-catalogue/host-tool-admission";
import { resolveNativeControllerModel } from "../config/native-decision-model";
import { durableComputerResultText } from "../tools/computer/model-result-projector";
import { BROWSER_DECISION_CONTROL_IDS } from "./browser-choice";
import { nativeDecisionHostArguments, parseNativeDecisionPlan, type NativeDecisionPlan } from "./native-decision-plan";
import { resolveGraphExecutionPolicy } from "./execution-policy";
import type { ChoiceInput } from "../providers/choice";
import { nativeObservationDelta } from "./native-observation-delta";
import { settleNativeExecution, nativeExecutionReplayKey, type NativeExecution } from "./native-execution";
import { createChoiceMenuProjector } from "./bound-choice";

type Observation = z.infer<typeof windowStateObservationSchema>;
type Control = NonNullable<Observation["controlCollection"]>["controls"][number];
export interface NativeDecisionState {
  turnId: string;
  owner?: { userId: string; roomId: string; agentId: string };
  modelId: string;
  plan: NativeDecisionPlan;
  observeArgs: Record<string, unknown>;
  observation: Observation | null;
  phase: "observe" | "decide" | "interpret" | "waiting" | "handoff" | "complete";
  pending: (ToolCall & { id: string }) | null;
  reason: string | null;
  generation: number;
  /** Reported takeover pauses Computer Use until a new Human turn. */
  humanTakeover?: boolean;
  /** Optional for old checkpoints. Explicit workflow delegation shares this run and executor. */
  execution?: NativeExecution;
  /** Optional for old checkpoints. A retained model is revalidated, never silently replaced. */
  controller?: { modelId: string; attemptedGeneration: number; active: boolean };
  history: Array<{ action: string; settlement: string; evidence: unknown; repetitions?: number }>;
  /** Retained across observation and redelegation; fresh handles do not settle an effect. */
  unresolved: Array<{ callId: string; operation: unknown; receipt: unknown; replayKey: string;
    /** Private evidence retained only for this delegated run's reconciliation. */
    before?: Record<string, unknown> | null;
    source?: unknown;
    resolution?: { generation: number; observationCallId: string; basis: "scoped_text_delta" | "model_interpretation" };
  }>;
  recovery: { limit: number; events: number; transitions: string[]; before: string | null };
}
export interface NativeDecisionCandidate {
  id: string;
  description: string;
  call: Pick<ToolCall, "name" | "args"> | null;
  controlId?: string;
  replayKey?: string;
  /** Code-bound authored inputs, retained across workflow/control selection. */
  inputReferences?: NativeExecution["boundInputs"];
  /** Semantic template only: executable targets and supplied bytes stay local. */
  presentation?: { purpose: string; operation: Record<string, unknown>; target?: string };
}
export function currentNativeDecision(state: NautiloState): NativeDecisionState | null {
  return state.nativeDecision?.turnId === state.turnId ? state.nativeDecision : null;
}

export function outstandingNativeEffects(decision: NativeDecisionState) {
  return decision.unresolved.filter(entry => !entry.resolution);
}

function retainedWorkflow(state: NautiloState): NativeDecisionState | null {
  const saved = state.nativeDecision;
  return saved?.execution && saved.phase !== "complete" && saved.owner
    && saved.owner.userId === state.userId && saved.owner.roomId === state.roomId && saved.owner.agentId === state.agentId
    ? saved : null;
}

/** Invocation-only guidance, not a new Room message or an entry router. */
export function nativeDecisionContinuationMessage(state: NautiloState): SystemMessage | null {
  const saved = retainedWorkflow(state);
  if (!saved || saved.turnId === state.turnId) return null;
  return new SystemMessage({ additional_kwargs: { nautilo_transient_context: true }, content: JSON.stringify({
    kind: "native_workflow_continuation", resumeFrom: saved.turnId, goal: saved.plan.goal,
    retainedValues: Object.entries(saved.plan.values).map(([name, value]) => ({ name, characters: value.length, sha256: digest(value) })),
    outstandingEffects: outstandingNativeEffects(saved).map(entry => ({ callId: entry.callId, receipt: entry.receipt })),
    instruction: "Only if the Human asks to continue this CUA workflow, issue fresh computer_observe with decisionPlan.execution=workflow and this exact resumeFrom reference. Code restores the original authored values; omit them from values, do not compose or copy them again. Completed effects and uncertainty remain retained; acquire fresh targets and never replay uncertain input. Unrelated messages follow ordinary Genie behavior and must not resume this workflow.",
  }) });
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

/** Only complete native menu ancestry can supply a literal command path.
 * Empty AXMenu containers are structural; labels are never guessed from a
 * task or app name. The driver resolves the live path at each expansion. */
function nativeMenuPath(control: Control, controls: readonly Control[]): string[] | null {
  if (control.role !== "menu_item") return null;
  const path: string[] = [];
  const visited = new Set<string>();
  let row: Control | undefined = control;
  while (row && !visited.has(row.id)) {
    visited.add(row.id);
    if (row.role === "menu_bar") return path.length ? path.reverse() : null;
    if (row.role !== "menu") {
      if ((row.role !== "menu_item" && row.role !== "menu_bar_item") || !row.label) return null;
      path.push(row.label);
    }
    row = controls.find(candidate => candidate.id === row?.parent);
  }
  return null;
}
export function nativeDecisionCandidates(decision: NativeDecisionState): NativeDecisionCandidate[] {
  const observation = decision.observation;
  if (!observation) return [];
  const controls = observation.controlCollection?.controls ?? [];
  const candidates: NativeDecisionCandidate[] = [];
  const seen = new Set<string>();
  const add = (purpose: string, operation: Record<string, unknown>, control?: Control, valueName?: string) => {
    if (control && operation["kind"] === "click" && operation["button"] === undefined
      && operation["axAction"] === undefined && operation["modifiers"] === undefined) {
      const path = nativeMenuPath(control, controls);
      if (path) add(`${purpose}; native menu route (preferred over clicking a closed submenu)`,
        { kind: "invoke_menu", target: observation.target, menuPath: path }, control);
    }
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
    const menuAlternative = operation["kind"] === "invoke_menu" && control !== undefined;
    const replayOperation = menuAlternative ? { kind: "click" } : replayOperationFor(operation);
    const replayLineage = operation["kind"] === "click" || menuAlternative ? lineage : null;
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
      ...(valueName === undefined ? {} : { inputReferences: [{ $valueRef: { source: "values" as const, path: [valueName] } }] }),
      presentation: { purpose, operation: describedOperation,
        ...(control ? {} : { target: "planned exact target or current window" }) },
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
    id, description: id === "completion_ready" ? decision.execution
      ? "Whole goal appears reached; nominate fresh evidence for the workflow completion review."
      : "Whole goal appears reached; return evidence for Genie verification."
      : id === "reobserve" ? "Read fresh state without repeating a mutation."
        : id === "needs_visual_evidence" ? decision.execution
          ? "Target or effect needs pixels; use the workflow's screenshot-capable operation menu."
          : "Target or effect needs pixels; return to the vision-capable Genie."
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
  const plan = parseNativeDecisionPlan(call.name, call.args);
  if (plan?.resumeFrom) {
    const retained = retainedWorkflow(state);
    if (!retained || retained.turnId !== plan.resumeFrom || plan.execution !== "workflow"
      || Object.entries(plan.values).some(([name, value]) => Object.hasOwn(retained.plan.values, name) && retained.plan.values[name] !== value))
      return "native_resume_reference_invalid_or_content_changed";
  }
  const decision = currentNativeDecision(state);
  if (decision?.humanTakeover && computerUseHostToolDefinition(call.name)) return "native_human_takeover_wait_for_user";
  const pending = decision?.pending;
  if (!decision || !pending || pending.id !== call.id) return null;
  if (decision.phase !== "waiting" || pending.name !== call.name
    || !sameJson(pending.args, call.args)) return "native_decision_proposal_changed";
  if (decision.execution) {
    if (!decision.execution.tools.includes(call.name) || !state.toolNames?.includes(call.name)
      || !resolveComputerUseHostToolRequest(call.name, call.args)) return "native_execution_tool_unavailable";
    if (computerUseHostToolDefinition(call.name)?.entry.descriptor.effectClass !== "read"
      && (decision.execution.mustObserve || outstandingNativeEffects(decision).length)) return "native_execution_effect_not_current";
    if (computerUseHostToolDefinition(call.name)?.entry.descriptor.effectClass !== "read"
      && decision.unresolved.some(entry => entry.replayKey === nativeExecutionReplayKey(call, decision.execution!.observation)))
      return "native_execution_uncertain_effect_replay_forbidden";
    return null; // Exact pending bytes were bound before entering ordinary preflights.
  }
  if (call.name === "computer_observe") return null;
  return nativeDecisionCandidates(decision).some((candidate) => candidate.call?.name === call.name
    && sameJson(candidate.call.args, call.args)) ? null : "native_decision_action_not_current_or_replay_fenced";
}

/** Project every comparison, including finalists. Retain non-candidate context
 * and ancestors; the complete observation and executable bindings stay local. */
export function projectNativeDecisionScreen(input: ChoiceInput, decision: NativeDecisionState, candidates: readonly NativeDecisionCandidate[]): ChoiceInput {
  if (!decision.observation?.controlCollection) return input;
  const rows = decision.observation.controlCollection.controls;
  const ids = new Set(input.choices.map((choice) => choice.id));
  const selected = candidates.filter((candidate) => ids.has(candidate.id));
  // Window/exact operations can depend on any row. Preserve that evidence.
  if (selected.some((candidate) => candidate.call?.name === "computer_do" && candidate.controlId === undefined)) return input;
  // A control-only decision (finish/recover/inspect) needs the whole state.
  if (!selected.some((candidate) => candidate.controlId !== undefined)) return input;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const actionControls = new Set(candidates.flatMap((candidate) => candidate.controlId ? [candidate.controlId] : []));
  const keep = new Set([
    ...rows.filter((row) => !actionControls.has(row.id)).map((row) => row.id),
    ...selected.flatMap((candidate) => candidate.controlId ? [candidate.controlId] : []),
  ]);
  for (const id of keep) {
    const row = byId.get(id);
    if (!row) return input;
    if (row.parent) keep.add(row.parent);
  }
  if (keep.size === rows.length) return input;
  const evidence = nativeDecisionEvidence(decision.observation);
  return { ...input,
    instructions: input.instructions + " The observation is a disclosed candidate projection, not the whole UI. Omitted candidate controls were not proven absent or irrelevant to the whole task. Compare the supplied candidates using their retained context; if this decision needs omitted evidence, defer_to_genie when offered rather than infer completion or safety from omission. During screening, nominate only within the group; no action executes.",
    state: { ...(input.state as Record<string, unknown>), observation: {
    ...evidence, collection: { ...evidence.collection,
      controls: evidence.collection!.controls.filter((row) => keep.has(row.id)),
      projection: { kind: input.choices.some((choice) => choice.id === "none_in_group") ? "screening_group" : "finalists",
        total: rows.length, included: keep.size, omittedCandidateControls: rows.length - keep.size },
    },
  } } };
}

/** Factor repeated operation semantics once per comparison. The same candidate
 * IDs resolve to the original calls; this changes neither eligibility nor scope. */
export function projectNativeDecisionMenu(input: ChoiceInput, decision: NativeDecisionState, candidates: readonly NativeDecisionCandidate[]): ChoiceInput {
  const projected = projectNativeDecisionScreen(input, decision, candidates);
  return createChoiceMenuProjector(candidates.map(candidate => ({ id: candidate.id,
    ...(candidate.presentation ? { presentation: { template: candidate.presentation,
      bindings: candidate.controlId ? { control: candidate.controlId } : {} } } : {}),
  })))({ ...projected, instructions: projected.instructions + " A choice's control names a retained observation row." });
}

export function nativeDecisionHandoffMessage(decision: NativeDecisionState): SystemMessage {
  return new SystemMessage({ id: `native-handoff:${randomUUID()}`, additional_kwargs: { nautilo_transient_context: true }, content: JSON.stringify({
    kind: "native_decision_handoff", reason: decision.reason, goal: decision.plan.goal,
    ...(decision.humanTakeover ? { instruction: "Computer Use is paused because local input was reported. Tell the Human that completed steps are retained and wait for them to resume. Do not reobserve, relaunch, retry, or redelegate in this turn. A later Human turn starts with fresh observation; never replay uncertain effects. This report does not identify which application received the input." } : {
      ...(decision.execution ? { question: decision.execution.question,
        continuation: "For composition, author the requested content once in decisionPlan.values. Delegate remaining routine work with decisionPlan.execution=workflow on a standalone fresh computer_observe call. Do not perform every UI step or retranscribe authored content. Use existing tools when the fast route is unavailable." } : {}),
      instruction: "Inspect current evidence and independently verify completion. Use ordinary Computer Use for visual grounding or diagnosis. Repair missing exact arguments before redelegating remaining work. A fresh target is not proof that an uncertain mutation did not happen; do not replay it.",
      ...(decision.reason === "native_decision_no_progress" ? { recovery: "Changing observation type or redelegating does not reset recovery. Use a genuinely different evidence-backed recovery route, or explain the unresolved prerequisite and wait. A successful launch followed by an empty window list is not evidence that the process needs launching again. Prefer an exact window's offered recovery over repeated broad scans." } : {}),
    }),
    ...(outstandingNativeEffects(decision).length ? { unresolved: outstandingNativeEffects(decision).map(entry => ({
      callId: entry.callId, receipt: entry.receipt, replayKey: entry.replayKey,
    })) } : {}),
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
  let current = currentNativeDecision(state);
  const call = calls[0]; const result = results[0];
  if (remaining.length || calls.length !== 1 || results.length !== 1 || !call?.id || !result
    || result.tool_call_id !== call.id || result.name !== call.name) return current ? handoff(current, "ordinary_genie_control") : null;
  const continues = current?.phase === "waiting" && current.pending?.id === call.id
    && current.pending.name === call.name && sameJson(current.pending.args, call.args);
  const plan = parseNativeDecisionPlan(call.name, call.args);
  if (plan?.resumeFrom) {
    const retained = retainedWorkflow(state);
    if (!retained || retained.turnId !== plan.resumeFrom || plan.execution !== "workflow"
      || Object.entries(plan.values).some(([name, value]) => Object.hasOwn(retained.plan.values, name) && retained.plan.values[name] !== value))
      return current ? handoff(current, "native_resume_reference_invalid_or_content_changed") : null;
    current = { ...retained, humanTakeover: retained.turnId === state.turnId && retained.humanTakeover === true };
  }
  const source = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
  const starts = plan && modelId && state.turnId && source?.tool_calls?.length === 1 && source.tool_calls[0]?.id === call.id;
  if (!continues && !starts) {
    // Genie may diagnose after a fast-loop handoff, but it must not erase a
    // takeover or an uncertain effect simply by issuing an ordinary tool call.
    const checked = current?.execution && computerUseHostToolDefinition(call.name) ? nativeDecisionResult(result) : null;
    if (current?.execution && checked) {
      const settled = settleNativeExecution(current, { ...call, id: call.id }, checked);
      return handoff(settled, settled.reason ?? "ordinary_genie_control");
    }
    return current ? handoff(current, "ordinary_genie_control") : null;
  }
  const controller = starts && plan.execution === "workflow"
    ? resolveNativeControllerModel(current?.controller?.modelId) : null;
  let next: NativeDecisionState = starts ? {
    turnId: state.turnId, modelId, plan: { ...plan, values: { ...current?.plan.values, ...plan.values } },
    ...(state.userId && state.roomId && state.agentId ? { owner: { userId: state.userId, roomId: state.roomId, agentId: state.agentId } } : {}),
    observeArgs: nativeDecisionHostArguments(call.name, call.args) as Record<string, unknown>,
    observation: null, phase: "decide", pending: null, reason: null, generation: (current?.generation ?? 0) + 1,
    history: current?.history ?? [], unresolved: current?.unresolved ?? [],
    ...(current?.humanTakeover ? { humanTakeover: true } : {}),
    recovery: current?.recovery ?? { limit: resolveGraphExecutionPolicy().browserDecisionInterventionLimit, events: 0, transitions: [], before: null },
    ...(plan.execution === "workflow" ? { execution: {
      request: current?.execution?.request ?? plan.goal, tools: state.toolNames ?? [],
      observation: null, observationCallId: null, freshRead: false, mustObserve: false, question: null,
      ...(current?.execution?.boundInputs ? { boundInputs: current.execution.boundInputs } : {}),
      ...(current?.execution?.textMutation ? { textMutation: current.execution.textMutation } : {}),
      ...(current?.execution?.progressByRead ? { progressByRead: current.execution.progressByRead } : {}),
    }, ...(controller ? { controller: { modelId: controller.id, attemptedGeneration: (current?.generation ?? 0) + 1, active: true } } : {}) } : {}),
  } : { ...current!, pending: null };
  // The fast interpreter is optional. The eligible Choice model that admitted
  // this delegation remains the workflow gate; an absent interpreter is only
  // consequential when a later decision actually needs interpretation.
  const checked = nativeDecisionResult(result);
  if (!checked) {
    if (computerUseHostToolDefinition(call.name)?.entry.descriptor.effectClass !== "read") next.unresolved = [...next.unresolved, { callId: call.id, operation: call.args["operation"], receipt: { settlement: "unrecognized_result" }, replayKey: "unclassified" }];
    return handoff(next, "checked_host_result_unavailable");
  }
  if (next.execution) return settleNativeExecution(next, { ...call, id: call.id }, checked);
  const payload = checked["result"] as Record<string, unknown>;
  const settlement = String(checked["settlement"]);
  if (next.humanTakeover || (payload["outcome"] as Record<string, unknown> | undefined)?.["externalInterference"] === "user_input") {
    // Mutations still pass through receipt settlement below to retain unknown effects.
    next.humanTakeover = true;
    if (call.name === "computer_observe") return handoff(next, "human_takeover");
  }
  if (call.name === "computer_observe") {
    const parsed = windowStateObservationSchema.safeParse(payload);
    if (settlement !== "completed" || !parsed.success || !parsed.data.controlCollection || parsed.data.evidence === null) return handoff(next, "native_control_collection_unavailable");
    if (!sameJson(parsed.data.target, call.args["target"])) return handoff(next, "native_observation_target_changed");
    const last = next.history.at(-1);
    const retained = last?.evidence as Record<string, unknown> | undefined;
    if (last && retained && !Object.hasOwn(retained, "observed") && next.observation) {
      const before = nativeDecisionEvidence(next.observation);
      const after = nativeDecisionEvidence(parsed.data);
      next.history = [...next.history.slice(0, -1), { ...last, evidence: { ...retained,
        observed: { window: after.window,
          ...nativeObservationDelta(before.collection?.controls ?? [], after.collection?.controls ?? []),
          beforeCompleteness: before.collection?.completeness ?? "unavailable",
          completeness: after.collection?.completeness ?? "unavailable" },
      } }];
    }
    next = { ...next, observation: parsed.data, observeArgs: { ...next.observeArgs, target: parsed.data.target }, generation: next.generation + 1,
      ...(next.controller ? { controller: { ...next.controller, active: false } } : {}) };
    if (outstandingNativeEffects(next).some((entry) => entry.replayKey === "unclassified")) return handoff(next, "unresolved_effect_requires_verification");
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
  if (next.humanTakeover) return handoff(next, "human_takeover");
  // Refused actions may recover. Unknown effects stay fenced from replay across
  // fresh handles; different recovery actions and observations remain available.
  if (settlement !== "completed" && !unknown && payload["completionCertainty"] !== "not_completed") return handoff(next, "unclassified_action_failure");
  const window = payload["window"];
  const appeared = payload["postObservation"] as { window?: { target?: unknown } } | undefined;
  if (window && call.args["operation"] && (call.args["operation"] as Record<string, unknown>)["kind"] === "launch_app") next.observeArgs = { operation: "window_state", target: window };
  else if (appeared?.window?.target) next.observeArgs = { operation: "window_state", target: appeared.window.target };
  return { ...next, phase: "observe", reason: null };
}
