import { createHash } from "node:crypto";
import { validate, type Schema } from "@cfworker/json-schema";
import { z } from "zod";
import { CUA_MACOS_KEY_PATTERN, desktopStateObservationSchema, windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";
import { canonicalizeComputerUseJson } from "@nautilo/computer-use-contracts";
import type { ToolCall } from "@langchain/core/messages/tool";
import { outstandingNativeEffects, type NativeDecisionState } from "./native-decision";
import { computerUseHostToolDefinition } from "../config/computer-use-catalogue/host-tool-admission";
import { nativeControlProgress, nativeObservationDelta } from "./native-observation-delta";

const pathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
const referenceSchema = z.object({ $valueRef: z.object({
  source: z.enum(["request", "values", "observation", "readArguments"]), path: pathSchema,
  slice: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict().optional(),
}).strict() }).strict();
export const nativeExecutionReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reconcile"), callId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("call"), tool: z.string().min(1), arguments: z.record(z.string(), z.json()) }).strict(),
  z.object({ kind: z.literal("genie"), reason: z.enum(["composition", "reasoning", "intent", "missing_capability", "unresolved_effect"]), question: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("complete"), summary: z.string().min(1), checks: z.array(z.object({
    path: pathSchema, comparison: z.enum(["equals", "contains", "appends"]), expected: z.union([referenceSchema, z.boolean(), z.number()]),
    appendBefore: z.string().optional(),
  }).strict()).nonempty() }).strict(),
]);
export type NativeExecutionReply = z.infer<typeof nativeExecutionReplySchema>;
export interface NativeExecution {
  request: string;
  tools: string[];
  /** Checked semantic result only; no raw provider tree or transport envelope. */
  observation: Record<string, unknown> | null;
  observationCallId: string | null;
  freshRead: boolean;
  mustObserve: boolean;
  question: string | null;
  /** Fresh-acquisition inputs, never an immutable inventory-page cursor. */
  lastRead?: { tool: string; arguments: Record<string, unknown> };
  /** A refused read needs an explicit recovery decision, not automatic replay. */
  readbackFailed?: boolean;
  /** Last semantic state per read scope; switching surfaces is not progress. */
  progressByRead?: Record<string, string>;
  /** Single-use continuations already proposed within this inventory context. */
  continued?: string[];
  /** Exact request/authored inputs already bound for proposed work. These are
   * expectations, not observations or proof of task completion. */
  boundInputs?: z.infer<typeof referenceSchema>[];
  /** Private before-state, captured from the exact targeted pre-action row.
   * Fresh control references rotate, so later correlation is semantic within
   * the same window and is explicitly not persistent element identity. */
  textMutation?: { input: z.infer<typeof referenceSchema>; before: string | null; window: unknown; scope: string[] | null; settlement: string } | undefined;
  pendingProgress?: { before: string; action: unknown; receipt: unknown } | undefined;
}
export type NativeExecutionRoots = { request: string; values: Record<string, string>; observation: Record<string, unknown> | null; readArguments?: Record<string, unknown> };

/** Also normalizes checkpoints produced before continuation and acquisition
 * were separated. Preserve query/selector/effort; only desktop page cursors
 * are snapshot-bound rather than fresh acquisition parameters. */
export function nativeFreshRead(read: NativeExecution["lastRead"]): NativeExecution["lastRead"] {
  if (!read) return;
  return { tool: read.tool, arguments: Object.fromEntries(Object.entries(read.arguments).filter(([key]) =>
    key !== "decisionPlan" && !(read.tool === "computer_observe" && read.arguments["operation"] === "desktop_state" && key === "continuation"))) };
}

export function nativeExecutionInputReferences(value: unknown): z.infer<typeof referenceSchema>[] {
  const ref = referenceSchema.safeParse(value).data;
  if (ref) return ["request", "values"].includes(ref.$valueRef.source) ? [ref] : [];
  return value && typeof value === "object" ? Object.values(value).flatMap(nativeExecutionInputReferences) : [];
}

/** Generate only exact equalities that already hold on fresh state. The model
 * still judges whether these facts satisfy the ENTIRE goal; matching one input
 * never automatically completes a workflow. No model-authored paths/checks. */
export function nativeExecutionCompletionChoice(decision: NativeDecisionState): Extract<NativeExecutionReply, { kind: "complete" }> | undefined {
  const execution = decision.execution;
  if (!execution?.freshRead || execution.mustObserve || outstandingNativeEffects(decision).length) return;
  const roots = { ...execution, values: decision.plan.values };
  const expected = (execution.boundInputs ?? []).map(ref => ({ ref, value: bindNativeExecutionValue(ref, roots) }))
    .filter(row => typeof row.value === "string" && row.value.length > 0);
  const checks: Extract<NativeExecutionReply, { kind: "complete" }>["checks"] = [];
  const visit = (value: unknown, path: (string | number)[]) => {
    for (const row of expected) if (value === row.value && !(execution.textMutation?.before !== null
      && execution.textMutation?.before !== undefined && execution.textMutation.scope !== null
      && sameJson(row.ref, execution.textMutation.input)))
      checks.push({ path, comparison: "equals", expected: row.ref });
    if (Array.isArray(value)) value.forEach((child, index) => visit(child, [...path, index]));
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(execution.observation, []);
  const append = scopedAppendFact(decision);
  if (append) checks.push(append);
  return checks.length ? { kind: "complete", summary: "Verified the requested result from fresh application state.", checks } : undefined;
}

type Window = NonNullable<ReturnType<typeof windowStateObservationSchema.safeParse>["data"]>;
type Control = NonNullable<Window["controlCollection"]>["controls"][number];

function controlScope(control: Control, controls: readonly Control[]): string[] | null {
  const scope: string[] = [];
  const seen = new Set<string>();
  let current: Control | undefined = control;
  while (current) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    scope.unshift(JSON.stringify([current.role, current.label ?? null]));
    if (current.parent) {
      const parent = controls.find(row => row.id === current!.parent);
      if (!parent) return null;
      current = parent;
    } else current = undefined;
  }
  return scope;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(canonicalizeComputerUseJson(left)) === JSON.stringify(canonicalizeComputerUseJson(right));
}

function scopedAppendFact(decision: NativeDecisionState, reconciling = false): Extract<NativeExecutionReply, { kind: "complete" }>["checks"][number] | undefined {
  const execution = decision.execution;
  const mutation = execution?.textMutation;
  if (!execution?.freshRead || execution.mustObserve || (!reconciling && outstandingNativeEffects(decision).length) || !mutation || (!reconciling && mutation.settlement !== "completed")
    || mutation.before === null || mutation.scope === null) return;
  const window = windowStateObservationSchema.safeParse(execution.observation).data;
  const controls = window?.controlCollection?.controls;
  if (!window || !controls || !sameJson(window.target, mutation.window)) return;
  const matching = controls.map((control, index) => ({ control, index, scope: controlScope(control, controls) }))
    .filter(row => row.scope && sameJson(row.scope, mutation.scope));
  if (matching.length !== 1) return;
  const text = bindNativeExecutionValue(mutation.input, { ...execution, values: decision.plan.values });
  if (typeof text !== "string" || !text.length || matching[0]!.control.state.value !== mutation.before + text) return;
  return { path: ["controlCollection", "controls", matching[0]!.index, "state", "value"], comparison: "appends",
    expected: mutation.input, appendBefore: mutation.before };
}

/** A reconciliation is an assessment of a fresh, scoped transition, never a
 * rewritten delivery receipt. Text insertion requires exact code-owned delta
 * evidence; a model's impression of a screenshot cannot settle duplicate input.
 * Other effects may be assessed from retained before/after scope and pixels.
 * Absence/unchanged state never issues permission to replay. */
export function nativeReconciliationChoices(decision: NativeDecisionState): Array<{ callId: string; basis: "scoped_text_delta" | "model_interpretation"; evidence: unknown }> {
  const execution = decision.execution;
  if (!execution?.freshRead || execution.mustObserve || !execution.observationCallId || decision.humanTakeover) return [];
  const after = windowStateObservationSchema.safeParse(execution.observation).data;
  if (!after || after.outcome.externalInterference === "user_input") return [];
  return outstandingNativeEffects(decision).flatMap<{ callId: string; basis: "scoped_text_delta" | "model_interpretation"; evidence: unknown }>(entry => {
    const operation = schemaRecord(entry.operation);
    const before = windowStateObservationSchema.safeParse(entry.before).data;
    if (!before || !sameJson(before.target, after.target)) return [];
    if (["type_text", "set_value"].includes(String(operation["kind"]))) {
      const fact = operation["kind"] === "type_text" && outstandingNativeEffects(decision).length === 1 ? scopedAppendFact(decision, true) : undefined;
      return fact ? [{ callId: entry.callId, basis: "scoped_text_delta" as const,
        evidence: nativeExecutionCompletionEvidence({ kind: "complete", summary: "Assess exact insertion", checks: [fact] }, { ...execution, values: decision.plan.values }) }] : [];
    }
    const delta = nativeObservationDelta(before.controlCollection?.controls ?? [], after.controlCollection?.controls ?? []);
    if (!delta.addedOrChanged.length && !delta.removedOrChanged.length && sameJson(before.evidence, after.evidence)) return [];
    return [{ callId: entry.callId, basis: "model_interpretation" as const, evidence: {
      action: entry.source ?? null, receipt: entry.receipt, window: after.evidence,
      beforeCompleteness: before.completeness, afterCompleteness: after.completeness, delta,
      qualification: "Same observed window, not persistent control identity. Interpret the requested effect using this transition and fresh image when available. A changed tree alone is not proof; missing/unchanged/ambiguous evidence cannot settle it.",
    } }];
  });
}

export function nativeExecutionReplayKey(call: Pick<ToolCall, "name" | "args">, observation: unknown): string {
  const { target: _target, deliveryMode: _deliveryMode, delayMs: _delayMs, ...operation } = schemaRecord(call.args["operation"]);
  const window = windowStateObservationSchema.safeParse(observation).data;
  const writing = operation["kind"] === "type_text" || operation["kind"] === "set_value";
  const controls = window?.controlCollection?.controls ?? [];
  const selected = controls.find(control => control.target && sameJson(control.target, _target));
  // Input effects stay fenced despite rotated handles, changed field values,
  // delivery mode, or switching insertion/replacement spelling.
  return progressDigest([call.name, writing ? { kind: "write_value", value: operation["text"] ?? operation["value"] } : operation,
    window?.target ?? null, !writing && selected ? controlScope(selected, controls) : null]);
}

/** Public context for a separate whole-goal judgment. Exact payload equality is
 * checked locally; authored bodies and native handles are not copied into the
 * review. Paths and their surrounding semantics distinguish a document value
 * from the same string in a placeholder, error, or unrelated control. This is
 * a projection of matching facts, not a claim to cover the whole application. */
export function nativeExecutionCompletionEvidence(reply: Extract<NativeExecutionReply, { kind: "complete" }>, roots: NativeExecutionRoots) {
  const expected = reply.checks.map(check => ({ reference: check.expected, value: bindNativeExecutionValue(check.expected, roots) }));
  const appendedValues = reply.checks.filter(check => check.comparison === "appends")
    .map(check => executionValueAt(roots.observation, check.path));
  const scopes = new Map<string, { path: (string | number)[]; fields: Record<string, unknown> }>();
  const scalars = (value: unknown): Record<string, unknown> => {
    const row = schemaRecord(value);
    if (typeof row["reference"] === "string" && typeof row["context"] === "string") return { boundTargetAvailable: true };
    return Object.fromEntries(Object.entries(row).filter(([, child]) => child === null || typeof child !== "object").map(([key, child]) => {
      if (typeof child === "string" && appendedValues.includes(child)) return [key, { scopedObservedValue: true }];
      const matches = expected.filter(item => item.value === child);
      return [key, matches.length ? { matchesInputs: matches.map(item => item.reference) } : child];
    }));
  };
  const facts = reply.checks.map((check, index) => {
    if (typeof check.expected === "object" && !["request", "values"].includes(check.expected.$valueRef.source)) throw new Error("native_completion_expectation_invalid");
    const actual = executionValueAt(roots.observation, check.path);
    const value = expected[index]!.value;
    const holds = check.comparison === "appends"
      ? typeof actual === "string" && typeof value === "string" && check.appendBefore !== undefined
        && actual === check.appendBefore + value
      : check.comparison === "contains"
      ? typeof actual === "string" && typeof value === "string" && value.length > 0 && actual.includes(value)
      : JSON.stringify(actual) === JSON.stringify(value);
    if (!holds) throw new Error("native_completion_fact_changed");
    for (let depth = 0; depth < check.path.length; depth++) {
      const path = check.path.slice(0, depth);
      const row = executionValueAt(roots.observation, path);
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const fields = scalars(row);
      // Include neighboring semantic records (e.g. window evidence), but not
      // unrelated collections or their complete text bodies.
      for (const [key, child] of Object.entries(row)) if (key !== check.path[depth] && child && typeof child === "object" && !Array.isArray(child)) {
        fields[key] = scalars(child);
      }
      scopes.set(JSON.stringify(path), { path, fields });
    }
    return { path: check.path, comparison: check.comparison, expected: check.expected, verified: true,
      ...(check.comparison === "appends" ? { outcome: { kind: "window_scoped_ax_append", placement: "end",
        beforeLength: check.appendBefore!.length, addedLength: (value as string).length,
        multiplicity: "one_exact_suffix", identityContinuity: "unproven",
        collectionCompleteness: schemaRecord(schemaRecord(roots.observation)["controlCollection"])["completeness"] ?? "unknown",
        evidenceBoundary: "Fresh AX values from a semantically unique field in the same exact window; not persistent element identity or whole-goal proof." } } : {}) };
  });
  return { coverage: "matching_fact_context_only", facts, scopes: [...scopes.values()] };
}

export function usesNativeReadArguments(value: unknown): boolean {
  if (referenceSchema.safeParse(value).data?.$valueRef.source === "readArguments") return true;
  return value !== null && typeof value === "object" && Object.values(value).some(usesNativeReadArguments);
}

export function executionValueAt(value: unknown, path: readonly (string | number)[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("native_binding_missing");
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/** Resolve exact existing bytes. The interpreter never supplies native handles
 * or rewrites content in a call; substring offsets refer to UTF-16 string units. */
export function bindNativeExecutionValue(template: unknown, roots: NativeExecutionRoots): unknown {
  if (template && typeof template === "object" && Object.hasOwn(template, "$valueRef")) {
    const { source, path, slice } = referenceSchema.parse(template).$valueRef;
    const value = executionValueAt(roots[source], path);
    if (!slice) return structuredClone(value);
    if (typeof value !== "string" || slice.end <= slice.start || slice.end > value.length) throw new Error("native_binding_range_invalid");
    // Do not split a Unicode surrogate pair at either boundary.
    for (const offset of [slice.start, slice.end]) {
      const code = value.charCodeAt(offset);
      if (code >= 0xdc00 && code <= 0xdfff) throw new Error("native_binding_range_invalid");
    }
    return value.slice(slice.start, slice.end);
  }
  if (Array.isArray(template)) return template.map(item => bindNativeExecutionValue(item, roots));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, bindNativeExecutionValue(value, roots)]));
  return template;
}

function schemaRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Literal strings are protocol constants/enums only. Other strings must be
 * mechanically bound, at this value or an enclosing object/array. The existing
 * finite key vocabulary is serialized as a regex, not an enum, in the Host schema. */
export function nativeExecutionStringsBound(template: unknown, bound: unknown, schema: unknown, root: unknown = schema): boolean {
  if (referenceSchema.safeParse(template).success) return true;
  const spec = schemaRecord(schema);
  if (typeof spec["$ref"] === "string") {
    if (!spec["$ref"].startsWith("#/")) return false;
    return nativeExecutionStringsBound(template, bound, executionValueAt(root,
      spec["$ref"].slice(2).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"))), root);
  }
  for (const union of ["anyOf", "oneOf"]) {
    const branches = spec[union];
    if (Array.isArray(branches)) return branches.some(branch => {
      const check = { ...schemaRecord(branch), ...(schemaRecord(root)["$defs"] ? { $defs: schemaRecord(root)["$defs"] } : {}) };
      return validate(bound, structuredClone(check) as Schema).valid && nativeExecutionStringsBound(template, bound, branch, root);
    });
  }
  if (Array.isArray(spec["allOf"]) && !spec["allOf"].every(branch => nativeExecutionStringsBound(template, bound, branch, root))) return false;
  if (typeof template === "string") return spec["const"] === template || (Array.isArray(spec["enum"]) && spec["enum"].includes(template))
    || (spec["pattern"] === CUA_MACOS_KEY_PATTERN.source && CUA_MACOS_KEY_PATTERN.test(template));
  if (Array.isArray(template)) return template.every((item, index) => nativeExecutionStringsBound(item,
    (bound as unknown[])[index], Array.isArray(spec["prefixItems"]) ? spec["prefixItems"][index] : spec["items"], root));
  if (template && typeof template === "object") return Object.entries(template).every(([key, value]) => nativeExecutionStringsBound(value,
    (bound as Record<string, unknown>)[key], schemaRecord(spec["properties"])[key] ?? spec["additionalProperties"], root));
  return true;
}

/** Opaque targets remain local. A provider sees where to bind one, not its bytes. */
export function projectNativeExecutionObservation(value: unknown, path: (string | number)[] = []): unknown {
  if (Array.isArray(value)) return value.map((item, index) => projectNativeExecutionObservation(item, [...path, index]));
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (typeof row["reference"] === "string" && typeof row["context"] === "string") {
    return { $valueRef: { source: "observation", path } };
  }
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, projectNativeExecutionObservation(item, [...path, key])]));
}

export function nativeExecutionCompletion(reply: Extract<NativeExecutionReply, { kind: "complete" }>, decision: NativeDecisionState): boolean {
  const execution = decision.execution;
  if (!execution?.freshRead || execution.mustObserve || !execution.observation || outstandingNativeEffects(decision).length) return false;
  return reply.checks.every(check => {
    // A fact compared to itself is not a postcondition. Expectations must come
    // from the request/authored inputs or explicit boolean/numeric predicates.
    if (typeof check.expected === "object" && !["request", "values"].includes(check.expected.$valueRef.source)) return false;
    if (check.comparison === "appends") {
      const fact = scopedAppendFact(decision);
      return fact !== undefined && sameJson(fact, check);
    }
    if (typeof check.expected === "object" && execution.textMutation?.before !== null
      && execution.textMutation?.before !== undefined && execution.textMutation.scope !== null
      && sameJson(check.expected, execution.textMutation.input)) return false;
    const expected = bindNativeExecutionValue(check.expected, { ...execution, values: decision.plan.values });
    const actual = executionValueAt(execution.observation, check.path);
    if (check.comparison === "contains") return typeof actual === "string" && typeof expected === "string" && expected.length > 0 && actual.includes(expected);
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

function progressDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeComputerUseJson(value))).digest("hex");
}

/** Transport handles rotate on reads. Compare semantic state, retaining
 * duplicate control occurrences and every exposed value, without using the
 * comparison to authorize an action or infer persistent element identity. */
function progressEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(progressEvidence);
  if (!value || typeof value !== "object") return value;
  const row = schemaRecord(value);
  if (typeof row["reference"] === "string" && typeof row["context"] === "string") return { boundTargetAvailable: true };
  const window = windowStateObservationSchema.safeParse(value).data;
  if (window) {
    const { target: _target, controlCollection, ...rest } = window;
    return { ...rest, ...(controlCollection ? { controlCollection: {
      ...controlCollection, controls: nativeControlProgress(controlCollection.controls),
    } } : {}) };
  }
  return Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== "context" && key !== "continuation")
    .map(([key, child]) => [key, progressEvidence(child)]));
}

function actionEvidence(call: ToolCall, observation: unknown, values: Record<string, string>) {
  const operation = schemaRecord(call.args["operation"]);
  const window = windowStateObservationSchema.safeParse(observation).data;
  const selected = operation["target"] === undefined ? undefined : window?.controlCollection?.controls.find(row =>
    row.target !== undefined && progressDigest(row.target) === progressDigest(operation["target"]));
  const { target: _target, id: _id, parent: _parent, ...control } = selected ?? {};
  const inputs = (value: unknown): unknown => {
    if (typeof value === "string") {
      const names = Object.keys(values).filter(name => values[name] === value);
      return names.length ? { suppliedValues: names } : value;
    }
    if (Array.isArray(value)) return value.map(inputs);
    return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inputs(child)])) : value;
  };
  const args = Object.fromEntries(Object.entries(call.args).filter(([key]) => key !== "decisionPlan"));
  return { tool: call.name, arguments: inputs(progressEvidence(args)),
    ...(window ? { window: window.evidence } : {}), ...(selected ? { control } : {}) };
}

export function settleNativeExecution(decision: NativeDecisionState, call: ToolCall & { id: string }, checked: Record<string, unknown>): NativeDecisionState {
  const execution = decision.execution!;
  const definition = computerUseHostToolDefinition(call.name);
  const read = definition?.entry.descriptor.effectClass === "read";
  let payload = schemaRecord(checked["result"]);
  let paginationError: string | null = null;
  let mergedDesktopPage = false;
  if (call.name === "computer_observe" && call.args["operation"] === "desktop_state"
    && checked["settlement"] === "completed" && call.args["continuation"] !== undefined) {
    try {
      payload = mergeNativeDesktopPage(execution.observation, payload, call.args["continuation"]);
      mergedDesktopPage = true;
    }
    catch { paginationError = "native_inventory_continuation_invalid_or_stalled"; }
  }
  const outcome = schemaRecord(payload["outcome"]);
  const settlement = String(checked["settlement"]);
  const unknown = !read && (settlement === "unknown_completion" || payload["completionCertainty"] === "unknown_completion"
    || payload["completionCertainty"] === "partially_completed" || outcome["stateChangeCertainty"] === "unknown"
    || (settlement !== "completed" && payload["completionCertainty"] !== "not_completed" && outcome["stateChangeCertainty"] !== "not_changed"));
  const receipt = { settlement, ...(payload["completionCertainty"] ? { completionCertainty: payload["completionCertainty"] } : {}), outcome };
  const operation: unknown = call.args["operation"] ?? null;
  const action = actionEvidence(call, execution.observation, decision.plan.values);
  const unresolved = unknown ? [...decision.unresolved, { callId: call.id, operation, receipt,
    replayKey: nativeExecutionReplayKey(call, execution.observation), before: execution.observation, source: action }] : decision.unresolved;
  const humanTakeover = decision.humanTakeover === true || outcome["externalInterference"] === "user_input";
  const handoff = humanTakeover ? "human_takeover" : paginationError ?? (["revoked", "cancelled", "fenced"].includes(settlement) ? settlement
    : null);
  const write = schemaRecord(operation);
  const beforeWindow = !read && write["kind"] === "type_text"
    ? windowStateObservationSchema.safeParse(execution.observation).data : undefined;
  const beforeControls = beforeWindow?.controlCollection?.controls ?? [];
  const targeted = beforeControls.filter(row => row.target !== undefined && sameJson(row.target, write["target"]));
  const scope = targeted.length === 1 ? controlScope(targeted[0]!, beforeControls) : null;
  const scoped = scope ? beforeControls.filter(row => sameJson(controlScope(row, beforeControls), scope)) : [];
  const input = typeof write["text"] === "string" ? execution.boundInputs?.find(ref =>
    bindNativeExecutionValue(ref, { ...execution, values: decision.plan.values }) === write["text"]) : undefined;
  const textMutation = !read && write["kind"] === "type_text" && input
    ? { input, before: targeted.length === 1 && typeof targeted[0]?.state.value === "string" ? targeted[0].state.value : null,
      window: beforeWindow?.target ?? null, scope: scoped.length === 1 ? scope : null, settlement } : undefined;
  const pendingProgress = !read ? { before: progressDigest(progressEvidence(execution.observation)), action, receipt } : execution.pendingProgress;
  const after = read && settlement === "completed" ? progressDigest(progressEvidence(payload)) : null;
  const readEvidence = schemaRecord(payload["evidence"]);
  // Window labels ground a semantic comparison, never execution authority.
  // Reads without semantic identity (e.g. empty app inventory) retain their
  // exact opaque target so two different apps cannot count against each other.
  const readScope: unknown = readEvidence["kind"] ? { kind: readEvidence["kind"], app: readEvidence["appLabel"], window: readEvidence["windowLabel"] }
    : call.args["target"] ?? null;
  const readKey = read ? progressDigest([call.name, progressEvidence(nativeFreshRead({ tool: call.name, arguments: call.args })!.arguments), readScope]) : null;
  const priorRead = readKey === null ? undefined : execution.progressByRead?.[readKey];
  const sameSurface = schemaRecord(execution.observation)["operation"] === payload["operation"];
  const before = priorRead ?? (execution.progressByRead === undefined && sameSurface ? pendingProgress?.before ?? decision.recovery.before : null);
  const signature = after === null ? null : progressDigest([readKey, before, pendingProgress?.action ?? action, pendingProgress?.receipt ?? receipt, after]);
  const repeated = signature !== null && decision.recovery.transitions.includes(signature);
  const noProgress = after !== null && (before === after || repeated);
  // Refused reads consume the existing no-progress recovery policy too. They
  // must neither reset recovery nor evade it by failing before a snapshot.
  const failedRead = read && settlement !== "completed";
  const changed = after !== null && !repeated && (before !== null && before !== after
    || execution.readbackFailed === true && priorRead === undefined);
  const events = failedRead || noProgress ? decision.recovery.events + 1 : changed ? 0 : decision.recovery.events;
  const reason = handoff ?? (events >= decision.recovery.limit ? "native_decision_no_progress" : null);
  const history = [...decision.history];
  const previousWindow = windowStateObservationSchema.safeParse(decision.observation).data;
  const nextWindow = read ? windowStateObservationSchema.safeParse(payload).data : undefined;
  if (pendingProgress && nextWindow && previousWindow && history.length) {
    const last = history.at(-1)!;
    history[history.length - 1] = { ...last, evidence: { ...schemaRecord(last.evidence), observed: {
      window: nextWindow.evidence,
      ...nativeObservationDelta(previousWindow.controlCollection?.controls ?? [], nextWindow.controlCollection?.controls ?? []),
    } } };
  }
  return { ...decision, humanTakeover, pending: null, generation: decision.generation + 1, phase: reason ? "handoff" : "interpret", reason, unresolved,
    ...(nextWindow ? { observation: nextWindow } : {}),
    history: [...history, { action: call.name, settlement, evidence: { ...receipt, source: action,
      operation: typeof operation === "string" ? operation : schemaRecord(operation)["kind"] ?? null,
      argumentsDigest: createHash("sha256").update(JSON.stringify(call.args)).digest("hex"),
    } }],
    recovery: { ...decision.recovery, events, before: after ?? decision.recovery.before,
      transitions: signature === null || repeated ? decision.recovery.transitions : [...decision.recovery.transitions, signature] },
    // Continuations enumerate one immutable snapshot; only its initial tool
    // message carries the image. New reads and all effects retire that source.
    execution: { ...execution, observation: payload, observationCallId: mergedDesktopPage ? execution.observationCallId : call.id,
      ...(read ? {} : { textMutation }),
      ...(after !== null && readKey !== null ? { progressByRead: { ...execution.progressByRead, [readKey]: after } } : {}),
      readbackFailed: failedRead,
      pendingProgress: read && settlement === "completed" ? undefined : pendingProgress,
      ...(read && call.args["operation"] === "desktop_state" && call.args["continuation"] === undefined ? { continued: [] } : {}),
      ...(read && settlement === "completed" && call.args["continuation"] === undefined
        ? { lastRead: nativeFreshRead({ tool: call.name, arguments: call.args })! } : {}),
      freshRead: read && settlement === "completed", mustObserve: read ? execution.mustObserve && settlement !== "completed" : true },
  };
}

/** Derive a complete inventory from the same Host snapshot, not a union of
 * unrelated desktops. Original tool receipts remain unchanged in Room history. */
export function mergeNativeDesktopPage(previous: unknown, current: unknown, continuation: unknown): Record<string, unknown> {
  const before = desktopStateObservationSchema.parse(previous);
  const page = desktopStateObservationSchema.parse(current);
  const requested = schemaRecord(continuation);
  if (!before.continuation || requested["context"] !== before.context || requested["reference"] !== before.continuation.reference
    || page.context !== before.context || page.discovered !== before.omitted || page.returned === 0
    || page.applicationTargets.returned !== 0) throw new Error("invalid_inventory_page");
  const targets = [...before.targets, ...page.targets];
  if (new Set(targets.map(row => row.target.reference)).size !== targets.length) throw new Error("overlapping_inventory_page");
  return desktopStateObservationSchema.parse({ ...page, targets, returned: targets.length,
    discovered: targets.length + page.omitted, applicationTargets: before.applicationTargets,
    ...(before.screenSnapshot ? { screenSnapshot: before.screenSnapshot } : {}) });
}
