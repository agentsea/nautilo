import { z } from "zod";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { NautiloState } from "../agent/state";
import { resolveGraphExecutionPolicy } from "./execution-policy";

const text = z.string().refine((value) => value.trim().length > 0).describe("Non-blank text");
const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot_contains"), text }),
  z.object({ kind: z.literal("url_equals"), url: z.url() }),
]);
const target = { role: text, name: text };
/** The Genie supplies intent and exact text; page text never supplies executable arguments. */
export const browserDecisionPlanSchema = z.object({
  goal: text,
  values: z.record(text, z.string()).optional().describe("Named exact text to enter, e.g. {'background hex': 'ffd8a8'}. Use purpose labels, not predicted field names. The runtime offers each value against fresh targets and copies the selected text unchanged with clear=true. Omit when no typing is needed."),
  constraints: z.array(text).default([]).describe("Additional task constraints; omitted means none"),
  allowedOrigins: z.array(z.url().refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:")
        && !url.username && !url.password;
    } catch { return false; }
  }, "Use an absolute HTTP(S) URL without credentials")
    .describe("Absolute HTTP(S) URL without credentials; the server extracts its origin"))
    .default([]).describe("Omit to bind to the freshly observed page origin. Supplied origins are normalized and deduplicated."),
  actions: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("click"), ...target }),
    z.object({ kind: z.literal("click_observed") }).describe("Delegate selection among all currently observed targets. The server builds candidates from each fresh snapshot; goal and constraints guide selection, while normal tool admission still applies."),
    z.object({ kind: z.literal("type"), ...target, text, clear: z.boolean() }),
    z.object({ kind: z.literal("press"), key: text }).describe("Exact key or combination accepted by browser_press, acting on the focused page control. Supply reusable keys once; the decision model chooses between them after each fresh observation. No key whitelist."),
    z.object({ kind: z.literal("hover"), ...target }),
    z.object({ kind: z.literal("double_click"), ...target }),
    z.object({ kind: z.literal("scroll_into_view"), ...target }),
    z.object({ kind: z.literal("select"), ...target, values: z.array(text).nonempty() }),
    z.object({ kind: z.literal("set_checked"), ...target, checked: z.boolean() }),
    z.object({ kind: z.literal("drag"), from: z.object(target), to: z.object(target) }),
    z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), amount: z.number().optional() }),
    z.object({ kind: z.literal("back") }),
    z.object({ kind: z.literal("forward") }),
    z.object({ kind: z.literal("reload") }),
    z.object({ kind: z.literal("open"), url: z.url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol)) }),
  ])).nonempty().default([{ kind: "click_observed" }]).describe("Omit to discover clicks from every fresh observation. Include click_observed with reusable keyboard, scrolling, selection or other ordinary browser action templates when needed. Exact arguments come from the Genie; semantic targets are resolved afresh."),
  progress: z.array(conditionSchema).default([]).describe("Optional known milestones. Omit when future page text is unknown; unchanged observations still trigger supervision."),
  success: z.array(conditionSchema).default([]).describe("Optional completion hints evaluated against the fresh observation. Matches are evidence, not stop conditions or proof of completion; the decision model assesses the whole goal before returning to the Genie for independent verification. Omit instead of guessing future page text."),
});
export type BrowserDecisionPlan = z.infer<typeof browserDecisionPlanSchema>;

const browserDecisionPlanKeys = new Set(Object.keys(browserDecisionPlanSchema.shape));
const browserSnapshotSelectorKeys = new Set(["appId", "historyToolCallId"]);
const browserSnapshotServerBindingKeys = new Set(["_requiredSession", "_requiredObservationId"]);

export type BrowserDecisionPlanInterpretation =
  | { kind: "none"; requestedDelegation: false }
  | { kind: "plan"; requestedDelegation: true; plan: BrowserDecisionPlan; source: "nested" | "top_level" }
  | { kind: "invalid"; requestedDelegation: boolean; error: z.ZodError | null; code: string; instruction: string };

/** Interpret raw model arguments once so admission and graph settlement cannot disagree. */
export function interpretBrowserDecisionPlanArgs(args: Record<string, unknown>): BrowserDecisionPlanInterpretation {
  const keys = Object.keys(args).filter((key) => !browserSnapshotServerBindingKeys.has(key));
  const hasNested = args["decisionPlan"] !== undefined;
  const topLevelPlanKeys = keys.filter((key) => browserDecisionPlanKeys.has(key));
  const hasPlanIntent = hasNested || topLevelPlanKeys.length > 0;
  if (hasNested) {
    if (keys.length !== 1) return {
      kind: "invalid", requestedDelegation: true, error: null,
      code: "decision_plan_mixed_arguments",
      instruction: "Send browser_snapshot with only decisionPlan for delegation. Do not mix nested or top-level plan fields with appId, historyToolCallId, or unknown arguments. No browser request was sent.",
    };
    const parsed = browserDecisionPlanSchema.safeParse(args["decisionPlan"]);
    return parsed.success
      ? { kind: "plan", requestedDelegation: true, plan: parsed.data, source: "nested" }
      : { kind: "invalid", requestedDelegation: true, error: parsed.error,
        code: "invalid_browser_decision_plan",
        instruction: "Correct the fields identified below and retry browser_snapshot with decisionPlan. No browser request was sent. Preserve the user's intent; do not guess missing actions or success evidence." };
  }
  if (topLevelPlanKeys.length > 0) {
    if (keys.some((key) => !browserDecisionPlanKeys.has(key))) return {
      kind: "invalid", requestedDelegation: true, error: null,
      code: "decision_plan_mixed_arguments",
      instruction: "Move the complete plan under decisionPlan and send no selector, history, or unknown arguments with it. No browser request was sent.",
    };
    const parsed = browserDecisionPlanSchema.safeParse(Object.fromEntries(keys.map((key) => [key, args[key]])));
    return parsed.success
      ? { kind: "plan", requestedDelegation: true, plan: parsed.data, source: "top_level" }
      : { kind: "invalid", requestedDelegation: true, error: parsed.error,
        code: "misplaced_browser_decision_plan",
        instruction: "The top-level arguments look like a browser decision plan but are invalid. Correct them and place the complete plan under decisionPlan. No browser request was sent. Preserve the user's intent." };
  }
  if (keys.length === 0 || (keys.length === 1 && browserSnapshotSelectorKeys.has(keys[0]!))) {
    return { kind: "none", requestedDelegation: false };
  }
  return {
    kind: "invalid", requestedDelegation: hasPlanIntent, error: null,
    code: "invalid_browser_snapshot_arguments",
    instruction: "Use browser_snapshot with no arguments, appId only, historyToolCallId only, or one complete decisionPlan. Unknown or mixed arguments are not accepted. No browser request was sent.",
  };
}

/** Generated from the tool's own schema, so repair guidance cannot drift from admission. */
export function browserDecisionPlanError(
  error: z.ZodError | null,
  code = "invalid_browser_decision_plan",
  instruction = "Correct the fields identified below and retry browser_snapshot with decisionPlan. No browser request was sent. Preserve the user's intent; do not guess missing actions or success evidence.",
  browserRequestSent: boolean | null = false,
): string {
  return JSON.stringify({
    error: code,
    browserRequestSent,
    instruction,
    issues: (error?.issues ?? []).map((issue) => ({ path: ["decisionPlan", ...issue.path], code: issue.code })),
    expectedContract: z.toJSONSchema(browserDecisionPlanSchema, { io: "input" }),
  });
}

export const browserDecisionObservationSchema = z.object({
  version: z.literal(1),
  snapshot: z.string(),
  refs: z.record(z.string().regex(/^e\d+$/), z.object({ role: text, name: z.string() }).strict()),
  pageUrl: z.url(),
  browserSessionId: text,
  observationId: text,
}).strict();
export type BrowserDecisionObservation = z.infer<typeof browserDecisionObservationSchema>;

/** Installed execution adapter; absent on older checkpoints means embedded browser. */
export interface ConnectedBrowserDecisionTarget {
  readonly kind: "connected_web";
  readonly operationId: string;
  readonly controlEpoch: number;
}

function isBrowserDecisionTool(name: string | undefined): boolean {
  return name?.startsWith("browser_") === true || name === "control_connected_web_operation";
}

function isBrowserDecisionSnapshot(call: Pick<ToolCall, "name" | "args">): boolean {
  return call.name === "browser_snapshot" || (call.name === "control_connected_web_operation"
    && (call.args["command"] as { kind?: unknown } | undefined)?.kind === "snapshot");
}

export function interpretBrowserDecisionCall(call: Pick<ToolCall, "name" | "args">): BrowserDecisionPlanInterpretation {
  if (!isBrowserDecisionSnapshot(call)) return { kind: "none", requestedDelegation: false };
  if (call.name === "browser_snapshot") return interpretBrowserDecisionPlanArgs(call.args);
  const { operationId: _operationId, expectedControlEpoch: _epoch, command: _command, ...plan } = call.args;
  return interpretBrowserDecisionPlanArgs(plan);
}

export function browserObservationFromResult(name: string | undefined, content: unknown): BrowserDecisionObservation | null {
  if (typeof content !== "string") return null;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const parsed = browserDecisionObservationSchema.safeParse(name === "control_connected_web_operation"
      ? value["ok"] === true ? value["observation"] : null : value);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** Route a shared semantic proposal through the exact operation's existing tool authority. */
export function browserDecisionDriverCall(
  call: Pick<ToolCall, "name" | "args">, target?: ConnectedBrowserDecisionTarget,
): Pick<ToolCall, "name" | "args"> {
  if (!target) return call;
  return { name: "control_connected_web_operation", args: {
    operationId: target.operationId, expectedControlEpoch: target.controlEpoch,
    command: { kind: call.name.slice("browser_".length), ...call.args },
  } };
}

export interface BrowserDecisionState {
  readonly turnId: string;
  readonly modelId: string;
  readonly target?: ConnectedBrowserDecisionTarget;
  readonly plan: BrowserDecisionPlan;
  readonly phase: "decide" | "observe" | "waiting" | "handoff";
  readonly observation: BrowserDecisionObservation | null;
  readonly pending: {
    readonly call: ToolCall & { id: string };
    readonly browserSessionId: string;
    readonly observationId: string | null;
  } | null;
  readonly reason: string | null;
  /** Missing only on pre-recovery checkpoints; consumers fail closed. */
  readonly recovery?: {
    /** Snapshotted once for this episode; live config changes do not rewrite it. */
    readonly interventionLimit: number;
    /** Recoverable errors and verified no-progress observations since the last milestone. */
    readonly consecutiveEvents: number;
    /** Absolute count at which this episode next requires Genie intervention. */
    readonly interventionAt: number;
    /** Stable keys for progress predicates already observed true in this turn. */
    readonly progressSeen: readonly string[];
    /** Whether the next fresh observation must count absence of new progress. */
    readonly assessNextObservation: boolean;
  };
}
export type BrowserDecisionCandidate = {
  readonly id: string;
  readonly description: string;
  readonly call: Pick<ToolCall, "name" | "args"> | null;
};

export function browserConditionMatches(
  condition: z.infer<typeof conditionSchema>, observation: BrowserDecisionObservation,
): boolean {
  return condition.kind === "url_equals" ? observation.pageUrl === condition.url
    : observation.snapshot.includes(condition.text);
}

export function browserDecisionCandidates(plan: BrowserDecisionPlan, observation: BrowserDecisionObservation, maxChoices: number):
  { candidates: BrowserDecisionCandidate[]; reason: null } | { candidates: []; reason: string } {
  if (!Number.isSafeInteger(maxChoices) || maxChoices < 3) {
    return { candidates: [], reason: "decision_capacity_cannot_fit_action_and_controls" };
  }
  // This bounds observed-state decisions, not the effects/navigation of an admitted click.
  const observedOrigin = new URL(observation.pageUrl).origin;
  if (!plan.allowedOrigins.some((value) => new URL(value).origin === observedOrigin)) {
    return { candidates: [], reason: "page_left_planned_origins" };
  }
  const candidates: BrowserDecisionCandidate[] = [];
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
  for (const action of plan.actions) {
    if (action.kind === "click_observed") {
      for (const [refId, ref] of Object.entries(observation.refs)) {
        const call = { name: "browser_click", args: { ref: `@${refId}` } };
        if (candidates.some((candidate) => JSON.stringify(candidate.call) === JSON.stringify(call))) continue;
        candidates.push({ id: `action_${candidates.length}`, call,
          description: JSON.stringify({ kind: "click", role: ref.role, name: ref.name, targetRef: `@${refId}` }) });
      }
      continue;
    }
    const resolveTarget = (wanted: { role: string; name: string }) => Object.entries(observation.refs).filter(([, ref]) =>
      normalize(ref.role) === normalize(wanted.role) && normalize(ref.name) === normalize(wanted.name));
    let args: Record<string, unknown>;
    let description: string;
    if (action.kind === "drag") {
      const from = resolveTarget(action.from);
      const to = resolveTarget(action.to);
      if (from.length > 1 || to.length > 1) return { candidates: [], reason: "ambiguous_target_requires_genie" };
      if (!from[0] || !to[0]) continue;
      args = { from: `@${from[0][0]}`, to: `@${to[0][0]}` };
      description = JSON.stringify(action);
    } else if ("role" in action) {
      const matches = resolveTarget(action);
      if (matches.length > 1) return { candidates: [], reason: "ambiguous_target_requires_genie" };
      const match = matches[0];
      if (!match) continue;
      args = { ref: `@${match[0]}` };
      if (action.kind === "type") Object.assign(args, { text: action.text, clear: action.clear });
      if (action.kind === "select") args["values"] = action.values;
      if (action.kind === "set_checked") args["checked"] = action.checked;
      description = JSON.stringify({ kind: action.kind, role: normalize(action.role), name: normalize(action.name),
        ...(action.kind === "type" ? { value: "Genie-supplied text", clear: action.clear } : {}),
        ...(action.kind === "select" ? { values: action.values } : {}),
        ...(action.kind === "set_checked" ? { checked: action.checked } : {}) });
    } else {
      if (action.kind === "open" && !plan.allowedOrigins.some((value) =>
        new URL(value).origin === new URL(action.url).origin)) {
        return { candidates: [], reason: "navigation_outside_planned_origins" };
      }
      const { kind, ...supplied } = action;
      args = supplied;
      description = JSON.stringify(kind === "open" ? { kind, url: "Genie-supplied URL" } : action);
    }
    const call = { name: `browser_${action.kind}`, args };
    if (candidates.some((candidate) => JSON.stringify(candidate.call) === JSON.stringify(call))) continue;
    if (candidates.some((candidate) => candidate.description === description)) {
      return { candidates: [], reason: "ambiguous_planned_action_requires_genie" };
    }
    candidates.push({ id: `action_${candidates.length}`, description, call });
  }

  // Preserve all observed roles: editable widgets are not limited to a static role list.
  // The decision model matches value purpose to fresh evidence; normal tool admission
  // and execution still validate the selected proposal.
  const templateCalls = new Set(candidates.map((candidate) => JSON.stringify(candidate.call)));
  for (const [valueName, value] of Object.entries(plan.values ?? {})) {
    for (const [refId, ref] of Object.entries(observation.refs)) {
      const call = { name: "browser_type", args: { ref: `@${refId}`, text: value, clear: true } };
      if (templateCalls.has(JSON.stringify(call))) continue;
      candidates.push({ id: `action_${candidates.length}`, call,
        description: JSON.stringify({ kind: "type", role: ref.role, name: ref.name,
          targetRef: `@${refId}`, valueName, value: "Genie-supplied text", clear: true }) });
    }
  }
  if (candidates.length === 0) return { candidates: [], reason: "no_planned_target_requires_genie" };
  candidates.push(
    { id: "reobserve", description: "Observe again because the page is still changing; do not repeat an uncertain action.", call: { name: "browser_snapshot", args: {} } },
    { id: "defer_to_genie", description: "The next step needs visual information that is absent from the text observation, so the Genie must inspect a screenshot; or the goal is already reached and needs independent verification; or uncertainty, ambiguity, conflicting evidence or scope requires the Genie.", call: null },
  );
  // Keep the complete action domain. Oversized sets are screened by Choice
  // against this same observation before one final action is proposed.
  return { candidates, reason: null };
}

export function currentBrowserDecision(state: NautiloState): BrowserDecisionState | null {
  const decision = state.browserDecision;
  return state.turnId && decision?.turnId === state.turnId ? decision : null;
}

function pairedBrowserToolResultIndexes(messages: readonly BaseMessage[]): Set<number> {
  const calls = new Map<string, string>();
  for (const message of messages) if (AIMessage.isInstance(message)) {
    for (const call of message.tool_calls ?? []) if (call.id && isBrowserDecisionTool(call.name)) {
      calls.set(call.id, call.name);
    }
  }
  return new Set(messages.flatMap((message, index) =>
    ToolMessage.isInstance(message) && isBrowserDecisionTool(message.name)
      && calls.get(message.tool_call_id) === message.name ? [index] : []));
}

/** Exact provider-projection anchor; ambiguous or reconstructed history fails closed. */
export function browserHandoffToolResultIndex(
  messages: readonly BaseMessage[],
  decision: BrowserDecisionState,
): number | null {
  const observation = decision.observation;
  if (!observation) return null;
  const paired = pairedBrowserToolResultIndexes(messages);
  const anchors = messages.flatMap((message, index) => {
    if (!paired.has(index) || !ToolMessage.isInstance(message) || !isBrowserDecisionTool(message.name)
      || typeof message.content !== "string") return [];
    try {
      const parsed = browserObservationFromResult(message.name, message.content);
      return parsed?.browserSessionId === observation.browserSessionId
        && parsed.observationId === observation.observationId ? [index] : [];
    } catch { return []; }
  });
  if (anchors.length !== 1) return null;
  for (let index = messages.length - 1; index >= anchors[0]!; index -= 1) {
    if (paired.has(index)) return index;
  }
  return null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function progressKey(condition: BrowserDecisionPlan["progress"][number]): string {
  return stableJson(condition);
}

function trueProgressKeys(
  plan: BrowserDecisionPlan,
  observation: BrowserDecisionObservation,
): string[] {
  return plan.progress
    .filter((condition) => browserConditionMatches(condition, observation))
    .map(progressKey);
}

function materialEvidenceKey(observation: BrowserDecisionObservation | null): string | null {
  return observation === null ? null : stableJson({
    pageUrl: observation.pageUrl,
    refs: observation.refs,
    snapshot: observation.snapshot,
  });
}

function interventionReason(cause: string, count: number, limit: number): string {
  return `browser_decision_intervention_required cause=${cause} count=${count} limit=${limit}`;
}

/** Record one recoverable event without retrying a provider call or browser effect. */
export function recordBrowserDecisionEvent(
  decision: BrowserDecisionState,
  cause: string,
  recoverPhase: "decide" | "observe",
): BrowserDecisionState {
  if (!decision.recovery) return immediateHandoff(decision, "browser_decision_recovery_state_unavailable");
  const consecutiveEvents = decision.recovery.consecutiveEvents + 1;
  const recovery = {
    ...decision.recovery,
    consecutiveEvents,
    assessNextObservation: false,
  };
  return consecutiveEvents >= decision.recovery.interventionAt
    ? {
        ...decision,
        phase: "handoff",
        pending: null,
        reason: interventionReason(cause, consecutiveEvents, decision.recovery.interventionLimit),
        recovery,
      }
    : { ...decision, phase: recoverPhase, pending: null, reason: null, recovery };
}

function settleFreshObservation(
  decision: BrowserDecisionState,
  observation: BrowserDecisionObservation,
): BrowserDecisionState {
  if (!decision.recovery) return immediateHandoff(decision, "browser_decision_recovery_state_unavailable");
  const alreadySeen = new Set(decision.recovery.progressSeen);
  const trueKeys = trueProgressKeys(decision.plan, observation);
  const madeProgress = trueKeys.some((key) => !alreadySeen.has(key));
  const progressSeen = [...new Set([...decision.recovery.progressSeen, ...trueKeys])].sort();
  if (madeProgress) {
    return {
      ...decision,
      phase: "decide",
      observation,
      pending: null,
      reason: null,
      recovery: {
        ...decision.recovery,
        consecutiveEvents: 0,
        interventionAt: decision.recovery.interventionLimit,
        progressSeen,
        assessNextObservation: false,
      },
    };
  }
  const observed = {
    ...decision,
    phase: "decide" as const,
    observation,
    pending: null,
    reason: null,
    recovery: { ...decision.recovery, progressSeen, assessNextObservation: false },
  };
  // Milestones are positive evidence, not an exhaustive list of intermediate
  // states. A changed observation permits another choice even when a declared
  // milestone is still pending. It does not clear prior errors; only a newly
  // verified milestone does that. Unchanged evidence consumes the budget.
  const noProgress = materialEvidenceKey(decision.observation) === materialEvidenceKey(observation);
  return decision.recovery.assessNextObservation && noProgress
    ? recordBrowserDecisionEvent(observed, "no_verified_progress", "decide")
    : observed;
}

function immediateHandoff(decision: BrowserDecisionState, reason: string): BrowserDecisionState {
  return { ...decision, phase: "handoff", pending: null, reason };
}

function safeBrowserFailureReason(value: unknown): string {
  switch (value) {
    case "browser_cancelled":
    case "browser_authority_lost":
    case "browser_outcome_unknown":
    case "browser_observation_invalid":
      return value;
    default:
      return "tool_failure_requires_genie_inspection";
  }
}

/** Called only after normal tool admission, execution and result protection. */
export function settleBrowserDecision(
  state: NautiloState,
  calls: readonly ToolCall[],
  results: readonly ToolMessage[],
  remaining: readonly ToolCall[],
  modelId: string,
): BrowserDecisionState | null {
  const current = currentBrowserDecision(state);
  const call = calls[0];
  const result = results[0];
  if (remaining.length || calls.length !== 1 || results.length !== 1 || !call || !result
    || result.tool_call_id !== call.id || result.name !== call.name) {
    return current
      ? { ...current, phase: "handoff", pending: null, reason: "ordinary_genie_control" }
      : null;
  }
  const pending = current?.pending;
  const continues = current?.phase === "waiting" && pending != null && pending.call.id === call.id
    && pending.call.name === call.name && JSON.stringify(pending.call.args) === JSON.stringify(call.args);
  const source = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
  const interpretedPlan = interpretBrowserDecisionCall(call);
  const proposedPlan = interpretedPlan?.kind === "plan" ? {
    ...interpretedPlan.plan,
    allowedOrigins: [...new Set(interpretedPlan.plan.allowedOrigins.map((value) => new URL(value).origin))].sort(),
  } : null;
  // A handoff cannot hide among dependent calls in a model-authored batch.
  const starts = (!current || current.phase === "handoff") && modelId && state.turnId
    && proposedPlan !== null && AIMessage.isInstance(source)
    && source.tool_calls?.length === 1 && source.tool_calls[0]?.id === call.id;
  if (!continues && !starts) return current ? { ...current, phase: "handoff", pending: null, reason: "ordinary_genie_control" } : null;
  if (current && !current.recovery) {
    return immediateHandoff(current, "browser_decision_recovery_state_unavailable");
  }
  const currentRecovery = current?.recovery;
  const initialLimit = currentRecovery?.interventionLimit
    ?? resolveGraphExecutionPolicy().browserDecisionInterventionLimit;
  const base: BrowserDecisionState = starts && proposedPlan !== null
    ? {
        turnId: state.turnId,
        modelId,
        ...(call.name === "control_connected_web_operation" ? { target: {
          kind: "connected_web" as const, operationId: String(call.args["operationId"]),
          controlEpoch: Number(call.args["expectedControlEpoch"]),
        } } : {}),
        plan: proposedPlan,
        phase: "decide",
        observation: null,
        pending: null,
        reason: null,
        recovery: currentRecovery ?? {
          interventionLimit: initialLimit,
          consecutiveEvents: 0,
          interventionAt: initialLimit,
          progressSeen: [],
          assessNextObservation: false,
        },
      }
    : { ...current!, pending: null };
  let connectedResult: Record<string, unknown> | null = null;
  if (call.name === "control_connected_web_operation" && typeof result.content === "string") {
    try { connectedResult = JSON.parse(result.content) as Record<string, unknown>; } catch { /* rejected below */ }
  }
  if (result.additional_kwargs?.["nautilo_tool_status"] !== "success"
    || (call.name === "control_connected_web_operation" && connectedResult?.["ok"] !== true)) {
    const failure = result.additional_kwargs?.["nautilo_browser_failure"] ?? connectedResult?.["browserFailure"];
    return continues && failure === "browser_observation_stale"
      ? recordBrowserDecisionEvent(base, "browser_observation_stale", "observe")
      : immediateHandoff(base, safeBrowserFailureReason(failure));
  }
  if (!isBrowserDecisionSnapshot(call)) {
    return {
      ...base,
      phase: "observe",
      reason: null,
      recovery: { ...base.recovery!, assessNextObservation: true },
    };
  }
  const observation = browserObservationFromResult(result.name, result.content);
  if (!observation || (continues && observation.browserSessionId !== pending?.browserSessionId)) {
    return immediateHandoff(base, "fresh_bound_observation_unavailable");
  }
  if (starts && proposedPlan !== null) {
    if (!["http:", "https:"].includes(new URL(observation.pageUrl).protocol)) {
      return immediateHandoff(base, "routine_browser_requires_http_origin");
    }
    // The browser supplies the current origin; the Genie need not reproduce it.
    const resolvedPlan = { ...proposedPlan, allowedOrigins: proposedPlan.allowedOrigins.length
      ? proposedPlan.allowedOrigins : [new URL(observation.pageUrl).origin] };
    const started = { ...base, plan: resolvedPlan };
    if (current?.phase === "handoff") {
      const changedPlan = stableJson(current.plan) !== stableJson(resolvedPlan);
      const changedEvidence = materialEvidenceKey(current.observation)
        !== materialEvidenceKey(observation);
      if (!changedPlan && !changedEvidence) {
        return immediateHandoff(
          current,
          `browser_decision_restart_requires_revised_plan_or_evidence count=${currentRecovery!.consecutiveEvents} limit=${currentRecovery!.interventionLimit}`,
        );
      }
      const progressSeen = [...new Set([
        ...currentRecovery!.progressSeen,
        ...trueProgressKeys(resolvedPlan, observation),
      ])].sort();
      return {
        ...started,
        observation: observation,
        recovery: {
          ...currentRecovery!,
          interventionAt: currentRecovery!.consecutiveEvents + currentRecovery!.interventionLimit,
          progressSeen,
          assessNextObservation: false,
        },
      };
    }
    return {
      ...started,
      observation: observation,
      recovery: {
        ...base.recovery!,
        progressSeen: trueProgressKeys(resolvedPlan, observation).sort(),
      },
    };
  }
  return settleFreshObservation(base, observation);
}

export function browserDecisionHandoffContent(reason: string): string {
  // An older checkpoint may have stopped on a literal completion-hint match.
  if (reason === "plan_success_already_true" || reason === "success_evidence_requires_genie_verification") {
    return "Routine browser control previously stopped on a completion-hint match. That match is not proof that the goal was reached. Inspect the latest observation, independently verify the outcome, and delegate any remaining routine work. You need not supply completion predicates. Do not blindly replay an uncertain action.";
  }
  if (reason.startsWith("complete_candidates_exceed_model_limit ")) return browserDecisionPlanError(null, reason,
    "The snapshot completed, but its complete action set exceeded the decision model's catalogued choice capacity. No Choice request or routine action was sent. Preserve the user's intent and every exact value. Prefer exact role/name typing templates when the fresh observation identifies known targets. Otherwise delegate a smaller coherent segment with fewer currently needed named values, then resume the remaining work from fresh evidence. Do not truncate candidates, add a role whitelist, or alter the goal or values to fit.", true);
  return `Routine browser control returned to you: ${reason}. Inspect the latest tool evidence, verify outcomes, and revise the plan if needed. Do not blindly replay an uncertain action. Existing run budgets and approvals still apply.`;
}
