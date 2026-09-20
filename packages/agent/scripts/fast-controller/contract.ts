import { z } from "zod";

const ref = z.string().min(1);
const link = z.object({ ref, explanation: z.string().min(1) }).strict();
const links = z.array(link).nonempty();
const claim = z.object({ criterionId: ref, evidence: links }).strict();
export const delegationSchema = z.object({
  version: z.literal(1), taskId: ref, revision: z.number().int().nonnegative(),
  intent: z.object({ requestRef: ref, origin: z.enum(["direct_request", "supervisor"]) }).strict(),
  goal: z.string().min(1), constraints: z.array(z.string()),
  values: z.array(z.object({ ref, purpose: z.string(), contentHash: ref }).strict()),
  success: z.array(z.object({ id: ref, statement: z.string().min(1),
    verification: z.enum(["semantic", "visual", "either"]) }).strict()).nonempty(),
}).strict().superRefine((value, context) => {
  for (const ids of [value.success.map(row => row.id), value.values.map(row => row.ref)]) {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate references" });
  }
});

/** Only the installed adapter supplies operation/read/predicate schemas. This
 * experimental envelope does not enumerate or expand Computer Use authority. */
export function createControllerContract(adapter: {
  operation: z.ZodType; read: z.ZodType; predicate: z.ZodType;
}) {
  const check = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("semantic"), criterionId: ref.nullable(), predicate: adapter.predicate }).strict(),
    z.object({ kind: z.literal("visual"), criterionId: ref.nullable(), question: z.string().min(1) }).strict(),
  ]);
  const decision = z.object({
    version: z.literal(1), taskId: ref, revision: z.number().int().nonnegative(),
    checkpointId: ref, observationId: ref, basis: links,
    body: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("act"), operation: adapter.operation, verify: z.array(check).nonempty() }).strict(),
      z.object({ kind: z.literal("observe"), request: adapter.read, question: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("await_change"), check, reason: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("complete"), criteria: z.array(claim).nonempty() }).strict(),
      z.object({ kind: z.literal("escalate"), reason: z.enum(["missing_input", "ambiguous_intent", "needs_reasoning",
        "needs_authority", "unresolved_effect", "no_progress", "capability_unavailable"]),
      question: z.string().min(1), evidence: links }).strict(),
    ]),
  }).strict();
  const supervisor = z.object({
    handoffId: ref, taskId: ref, baseRevision: z.number().int().nonnegative(), baseCheckpointId: ref,
    resolution: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("resume"), revisedDelegation: delegationSchema, suppliedEvidence: z.array(link) }).strict(),
      z.object({ kind: z.literal("take_control"), purpose: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("finish"), criteria: z.array(claim).nonempty() }).strict(),
      z.object({ kind: z.literal("stop"), reason: z.string().min(1) }).strict(),
    ]),
  }).strict();
  return { decision, supervisor };
}

export type Delegation = z.infer<typeof delegationSchema>;
export type ControllerContract = ReturnType<typeof createControllerContract>;
export type Decision = z.infer<ControllerContract["decision"]>;
export type Claims = Array<z.infer<typeof claim>>;
export type Receipt = { operationId: string; outcome: "applied" | "not_applied" | "unknown" | "partial" };
export type Proof = { criterionId: string; evidenceRefs: string[]; basis: "semantic" | "visual" };
export type Grounding = { observationId: string; evidenceRefs: string[] };
export interface Observation {
  id: string;
  evidenceRefs: string[];
  /** Trusted verifier results, not the model's claims or proposed predicates. */
  proofs: Proof[];
  resolutions: Array<{ operationId: string; outcome: "applied" | "not_applied"; evidenceRefs: string[] }>;
}
export interface ControllerState {
  delegation: Delegation;
  sequence: number;
  phase: "observe" | "decide" | "waiting" | "handoff" | "supervisor" | "stopped" | "complete";
  checkpointId: string;
  observation: Observation | null;
  observedIds: string[];
  pending: { id: string; replayKey: string; operation: unknown; grounding: Grounding; owner: "controller" | "supervisor" } | null;
  receipts: Receipt[];
  unresolved: Array<{ operationId: string; replayKey: string }>;
  reconciled: Observation["resolutions"];
  handoff: { id: string; reason: string; question: string } | null;
}
export type Effect =
  | { kind: "dispatch"; operationId: string; operation: unknown; verify: unknown }
  | { kind: "read"; request: unknown }
  | { kind: "await_change"; check: unknown };

function requireFact(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function advance(state: ControllerState, patch: Partial<ControllerState>): ControllerState {
  const sequence = state.sequence + 1;
  return { ...state, ...patch, sequence, checkpointId: `${state.delegation.taskId}:checkpoint:${sequence}` };
}
export function startController(input: unknown): ControllerState {
  const delegation = delegationSchema.parse(input);
  return { delegation, sequence: 0, phase: "observe", checkpointId: `${delegation.taskId}:checkpoint:0`,
    observation: null, observedIds: [], pending: null, receipts: [], unresolved: [], reconciled: [], handoff: null };
}

/** Pure transition. Only the harness/adapter may supply an observation and its
 * independently evaluated proofs; this is never a model-output endpoint. */
export function acceptObservation(state: ControllerState, observation: Observation): ControllerState {
  requireFact(state.phase === "observe" && !state.pending, "observation_not_expected");
  requireFact(observation.id && !state.observedIds.includes(observation.id), "fresh_observation_required");
  const knownEvidence = new Set(observation.evidenceRefs);
  const grounded = (refs: string[]) => refs.length > 0 && refs.every(id => knownEvidence.has(id));
  for (const proof of observation.proofs) {
    const criterion = state.delegation.success.find(row => row.id === proof.criterionId);
    requireFact(criterion && (criterion.verification === "either" || criterion.verification === proof.basis)
      && grounded(proof.evidenceRefs), "invalid_verifier_proof");
  }
  requireFact(new Set(observation.resolutions.map(row => row.operationId)).size === observation.resolutions.length,
    "duplicate_resolution");
  for (const resolution of observation.resolutions) {
    requireFact(state.unresolved.some(row => row.operationId === resolution.operationId)
      && grounded(resolution.evidenceRefs), "invalid_effect_resolution");
  }
  return advance(state, { observation, observedIds: [...state.observedIds, observation.id], phase: "decide",
    unresolved: state.unresolved.filter(row => !observation.resolutions.some(item => item.operationId === row.operationId)),
    reconciled: [...state.reconciled, ...observation.resolutions] });
}

function evidenceExists(state: ControllerState, entries: Array<{ ref: string }>) {
  requireFact(entries.every(entry => state.observation?.evidenceRefs.includes(entry.ref)), "unknown_evidence_reference");
}
function validateCompletion(state: ControllerState, claims: Claims) {
  requireFact(!state.pending && state.unresolved.length === 0, "unresolved_effect_prevents_completion");
  requireFact(claims.length === state.delegation.success.length
    && new Set(claims.map(row => row.criterionId)).size === claims.length, "incomplete_goal_coverage");
  for (const criterion of state.delegation.success) {
    const proposed = claims.find(row => row.criterionId === criterion.id);
    const verified = state.observation?.proofs.find(row => row.criterionId === criterion.id);
    requireFact(proposed && verified, "completion_not_verified");
    evidenceExists(state, proposed.evidence);
    requireFact(verified.evidenceRefs.every(id => proposed.evidence.some(item => item.ref === id)), "completion_evidence_mismatch");
  }
}

export interface Admission {
  /** Executed at dispatch time by the real adapter: fresh target, current
   * authority/cancellation, exact argument binding, and effect conflict key. */
  admit(operation: unknown, grounding: Grounding): { operation: unknown; replayKey: string };
  conflicts(replayKey: string, unresolvedReplayKey: string): boolean;
}

export function propose(state: ControllerState, raw: unknown, contract: ControllerContract, admission: Admission):
{ state: ControllerState; effect?: Effect } {
  requireFact(state.phase === "decide" && state.observation, "controller_not_deciding");
  const decision = contract.decision.parse(raw);
  requireFact(decision.taskId === state.delegation.taskId && decision.revision === state.delegation.revision
    && decision.checkpointId === state.checkpointId && decision.observationId === state.observation.id, "stale_decision");
  evidenceExists(state, decision.basis);
  const body = decision.body;
  if (body.kind === "act" || body.kind === "await_change") {
    const checks = body.kind === "act" ? body.verify : [body.check];
    requireFact(checks.every(check => check.criterionId === null
      || state.delegation.success.some(row => row.id === check.criterionId)), "unknown_criterion");
  }
  if (body.kind === "act") {
    const grounding = { observationId: decision.observationId, evidenceRefs: decision.basis.map(row => row.ref) };
    const admitted = admission.admit(body.operation, grounding);
    requireFact(admitted.replayKey.length > 0, "effect_scope_required");
    requireFact(!state.unresolved.some(row => admission.conflicts(admitted.replayKey, row.replayKey)), "unresolved_effect_conflict");
    const next = advance(state, { phase: "waiting" });
    const operationId = `${state.delegation.taskId}:operation:${next.sequence}`;
    return { state: { ...next, pending: { id: operationId, ...admitted, grounding, owner: "controller" } },
      effect: { kind: "dispatch", operationId, operation: admitted.operation, verify: body.verify } };
  }
  if (body.kind === "observe") return { state: advance(state, { phase: "observe" }), effect: { kind: "read", request: body.request } };
  if (body.kind === "await_change") return { state: advance(state, { phase: "observe" }), effect: { kind: "await_change", check: body.check } };
  if (body.kind === "complete") {
    validateCompletion(state, body.criteria);
    return { state: advance(state, { phase: "complete" }) };
  }
  evidenceExists(state, body.evidence);
  return { state: requestHandoff(state, body.reason, body.question) };
}

export function settle(state: ControllerState, receipt: Receipt): ControllerState {
  requireFact(state.pending?.id === receipt.operationId, "receipt_not_pending");
  requireFact(["applied", "not_applied", "unknown", "partial"].includes(receipt.outcome), "invalid_receipt");
  const unresolved = receipt.outcome === "unknown" || receipt.outcome === "partial"
    ? [...state.unresolved, { operationId: receipt.operationId, replayKey: state.pending.replayKey }] : state.unresolved;
  return advance(state, { pending: null, receipts: [...state.receipts, receipt], unresolved,
    phase: state.phase === "stopped" ? "stopped" : state.pending.owner === "supervisor" ? "supervisor" : "observe" });
}

export function requestHandoff(state: ControllerState, reason: string, question: string): ControllerState {
  requireFact(!state.pending && ["decide", "observe"].includes(state.phase), "handoff_not_available");
  const next = advance(state, { phase: "handoff" });
  return { ...next, handoff: { id: `${state.delegation.taskId}:handoff:${next.sequence}`, reason, question } };
}
export function stopController(state: ControllerState): ControllerState {
  requireFact(state.phase !== "complete", "task_already_complete");
  // Keep pending and unknown effects so late settlement remains truthful.
  return advance(state, { phase: "stopped", handoff: null });
}

export function supervise(state: ControllerState, raw: unknown, contract: ControllerContract): ControllerState {
  requireFact(state.phase === "handoff" && state.handoff && !state.pending, "supervision_not_expected");
  const reply = contract.supervisor.parse(raw);
  requireFact(reply.handoffId === state.handoff.id && reply.taskId === state.delegation.taskId
    && reply.baseRevision === state.delegation.revision && reply.baseCheckpointId === state.checkpointId, "stale_supervisor_reply");
  const resolution = reply.resolution;
  if (resolution.kind === "stop") return stopController(state);
  if (resolution.kind === "take_control") return advance(state, { phase: "supervisor", handoff: null, observation: null });
  if (resolution.kind === "finish") {
    validateCompletion(state, resolution.criteria);
    return advance(state, { phase: "complete", handoff: null });
  }
  evidenceExists(state, resolution.suppliedEvidence);
  requireFact(resolution.revisedDelegation.taskId === state.delegation.taskId
    && resolution.revisedDelegation.revision === state.delegation.revision + 1
    && resolution.revisedDelegation.intent.requestRef === state.delegation.intent.requestRef, "invalid_plan_revision");
  return advance(state, { delegation: resolution.revisedDelegation, observation: null, phase: "observe", handoff: null });
}

/** The supervisor shares admission and receipt settlement with the controller.
 * The caller must await/drain execution before handing control back. */
export function proposeSupervisorAction(state: ControllerState, raw: unknown, contract: ControllerContract, admission: Admission) {
  requireFact(state.phase === "supervisor" && !state.pending, "supervisor_not_ready");
  // Validate with the same operation schema by parsing a complete decision.
  const envelope = contract.decision.parse(raw);
  requireFact(envelope.body.kind === "act" && envelope.taskId === state.delegation.taskId
    && envelope.revision === state.delegation.revision && envelope.checkpointId === state.checkpointId,
  "invalid_supervisor_action");
  // Supervisor grounding is checked by the adapter's current admission, not
  // the controller's suspended/retired observation.
  const grounding = { observationId: envelope.observationId, evidenceRefs: envelope.basis.map(row => row.ref) };
  const admitted = admission.admit(envelope.body.operation, grounding);
  requireFact(admitted.replayKey.length > 0, "effect_scope_required");
  requireFact(!state.unresolved.some(row => admission.conflicts(admitted.replayKey, row.replayKey)), "unresolved_effect_conflict");
  const next = advance(state, { phase: "waiting" });
  const operationId = `${state.delegation.taskId}:operation:${next.sequence}`;
  return { state: { ...next, pending: { id: operationId, ...admitted, grounding, owner: "supervisor" as const } },
    effect: { kind: "dispatch" as const, operationId, operation: admitted.operation, verify: envelope.body.verify } };
}

export function returnFromSupervisor(state: ControllerState): ControllerState {
  requireFact(state.phase === "supervisor" && !state.pending, "supervisor_not_drained");
  return requestHandoff({ ...state, phase: "observe" }, "supervisor_returned", "Reacquire fresh evidence before continuing");
}
