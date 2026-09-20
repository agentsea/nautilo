import { z } from "zod";
import { createHash } from "node:crypto";
import { acceptObservation, createControllerContract, propose, requestHandoff, settle, startController, supervise,
  type ControllerState, type Decision, type Delegation, type Admission, type Observation } from "./fast-controller/contract";
import { createActionMatrix, resolveRoute, type RouteBinding } from "./fast-controller/routing";

/** Deliberately synthetic adapter: no Cua, shell, network, or application port.
 * Test-only operation subset is not a production capability allowlist. */
export const fixtureOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("launch"), application: z.string().min(1) }).strict().describe("Open the synthetic editor with one owned empty document; reuse it if already running."),
  z.object({ kind: z.literal("insert"), target: z.string().min(1), text: z.string().min(1) }).strict().describe("Insert exact supplied text at the current document control."),
  z.object({ kind: z.literal("dismiss"), target: z.string().min(1) }).strict().describe("Activate the current dialog's observed dismiss control."),
]);
export const fixtureContract = createControllerContract({ operation: fixtureOperation,
  read: z.object({ kind: z.literal("state") }).strict(),
  predicate: z.object({ kind: z.literal("readback") }).strict() });
export const fixtureTask: Delegation = {
  version: 1, taskId: "task", revision: 0, intent: { requestRef: "request", origin: "direct_request" },
  goal: "Insert the supplied text into the new document exactly once", constraints: ["Preserve existing documents"],
  values: [], success: [{ id: "done", statement: "Document contains the supplied text exactly once", verification: "semantic" }],
};
export const fixtureCheck = { kind: "semantic" as const, criterionId: null, predicate: { kind: "readback" } };

export function fixtureDecision(state: ControllerState, body: Decision["body"]): Decision {
  const observation = state.observation;
  if (!observation) throw new Error("Fixture has no current observation");
  return { version: 1, taskId: state.delegation.taskId, revision: state.delegation.revision,
    checkpointId: state.checkpointId, observationId: observation.id,
    basis: [{ ref: observation.evidenceRefs[0]!, explanation: "Current fixture state" }], body };
}
export function fixtureResume(state: ControllerState, goal = state.delegation.goal) {
  return { handoffId: state.handoff!.id, taskId: state.delegation.taskId,
    baseRevision: state.delegation.revision, baseCheckpointId: state.checkpointId,
    resolution: { kind: "resume", revisedDelegation: { ...state.delegation, goal, revision: state.delegation.revision + 1 },
      suppliedEvidence: [] } };
}

export function createControllerFixture(options: { launchOnly?: boolean; unknownInsert?: boolean; hiddenText?: boolean; surprise?: boolean } = {}) {
  let epoch = 0;
  let applicationRunning = false;
  let text = "";
  let dialog = options.surprise === true;
  let insertions = 0;
  const expectedText = "A quiet page becomes a field of light.";
  let currentTarget = "";
  const admission: Admission = {
    admit(raw, grounding) {
      if (grounding.observationId !== `observation-${epoch}` || grounding.evidenceRefs.length === 0
        || grounding.evidenceRefs.some(id => id !== `evidence-${epoch}`)) throw new Error("stale_fixture_observation");
      const operation = fixtureOperation.parse(raw);
      if (operation.kind === "launch") {
        if (operation.application !== "Fixture Editor") throw new Error("Unknown fixture app");
        return { operation, replayKey: "app:fixture" };
      }
      if (!applicationRunning) throw new Error("fixture_app_not_running");
      if (operation.target !== currentTarget) throw new Error("stale_fixture_target");
      if (operation.kind === "insert" && dialog) throw new Error("dialog_blocks_editor");
      return { operation, replayKey: operation.kind === "insert" ? "document:body" : "dialog" };
    },
    conflicts: (a, b) => a === b || a === "unclassified" || b === "unclassified",
  };
  function frame(state: ControllerState): Observation {
    epoch += 1;
    currentTarget = `target-${epoch}`;
    const evidenceRef = `evidence-${epoch}`;
    const goalVerified = applicationRunning && (options.launchOnly || (!options.hiddenText && text === expectedText && insertions === 1));
    // Independent fixture truth validates the ORIGINAL task, not a weaker
    // controller-produced success statement or operation acknowledgement.
    return { id: `observation-${epoch}`, evidenceRefs: [evidenceRef],
      proofs: goalVerified ? [{ criterionId: "done", evidenceRefs: [evidenceRef], basis: "semantic" }] : [],
      resolutions: !options.hiddenText && text === expectedText && insertions === 1
        ? state.unresolved.filter(row => row.replayKey === "document:body")
          .map(row => ({ operationId: row.operationId, outcome: "applied" as const, evidenceRefs: [evidenceRef] })) : [] };
  }
  function execute(state: ControllerState) {
    if (!state.pending || state.phase !== "waiting") throw new Error("No executable pending operation");
    const { operation } = admission.admit(state.pending.operation, state.pending.grounding); // revalidate at the execution boundary
    const op = fixtureOperation.parse(operation);
    if (op.kind === "launch") applicationRunning = true;
    if (op.kind === "dismiss") dialog = false;
    if (op.kind === "insert") { text += op.text; insertions += 1; }
    return settle(state, { operationId: state.pending.id,
      outcome: op.kind === "insert" && options.unknownInsert ? "unknown" : "applied" });
  }
  return { admission, frame, execute, expectedText,
    // Deliberately exclude the independent oracle and hidden document contents.
    visible: () => ({ applicationRunning, text: options.hiddenText ? null : text,
      dialog: applicationRunning && dialog, target: applicationRunning ? currentTarget : null,
      applications: [{ ref: "app-fixture", name: "Fixture Editor", available: true }],
      dialogText: applicationRunning && dialog ? "Welcome tip: This is your new document. Dismissing this tip does not discard or save any content." : null,
      controls: !applicationRunning ? [] : dialog
        ? [{ target: currentTarget, role: "button", label: "Dismiss welcome tip", enabled: true }]
        : [{ target: currentTarget, role: "text_area", label: "New document body", enabled: true }],
      textReadback: options.hiddenText ? "unavailable" : "available" }),
    target: () => currentTarget, inspect: () => ({ applicationRunning, text, insertions, dialog }) };
}

export const OFFLINE_CASES = ["direct", "controller", "surprise", "handoff_resume", "uncertain_readback", "uncertain_hidden"] as const;
export function runOfflineControllerProver(scenario: typeof OFFLINE_CASES[number]) {
  const fixture = createControllerFixture({ launchOnly: scenario === "direct", surprise: scenario === "surprise",
    unknownInsert: scenario.startsWith("uncertain"), hiddenText: scenario === "uncertain_hidden" });
  let state = acceptObservation(startController({ ...fixtureTask,
    goal: scenario === "direct" ? "Open Fixture Editor" : fixtureTask.goal }), fixture.frame(startController(fixtureTask)));
  let controllerDecisions = 0;
  let supervisorReplies = 0;
  let suppliedText = scenario === "handoff_resume" ? null : fixture.expectedText;
  const apply = (operation: unknown, controller = true) => {
    if (controller) controllerDecisions += 1;
    state = propose(state, fixtureDecision(state, { kind: "act", operation, verify: [fixtureCheck] }),
      fixtureContract, fixture.admission).state;
    state = fixture.execute(state);
    state = acceptObservation(state, fixture.frame(state));
  };
  const launch = { kind: "launch", application: "Fixture Editor" };
  const matrix = createActionMatrix([{ id: "launch", description: "Launch an observed application", input: fixtureOperation }],
    [{ capabilityId: "launch", arguments: launch, description: "Open Fixture Editor", evidenceRefs: state.observation!.evidenceRefs }],
    state.observation!.evidenceRefs);
  const binding: RouteBinding = { requestId: "request", requestRevision: 0, observationId: state.observation!.id, authorityGeneration: "authority" };
  const route = resolveRoute(scenario === "direct" ? { route: "direct", operationRef: "direct_0" } : { route: "execute" }, binding, binding, matrix);
  if (route.proposal) apply(route.proposal.arguments, false);
  else {
    apply(launch);
    if (scenario === "surprise") apply({ kind: "dismiss", target: fixture.target() });
    if (scenario === "handoff_resume") {
      state = propose(state, fixtureDecision(state, { kind: "escalate", reason: "missing_input",
        question: "Supply the exact text to insert", evidence: [{ ref: state.observation!.evidenceRefs[0]!, explanation: "Empty document" }] }),
      fixtureContract, fixture.admission).state;
      const reply = fixtureResume(state);
      reply.resolution.revisedDelegation.values = [{ ref: "supplied-text", purpose: "Exact document content",
        contentHash: createHash("sha256").update(fixture.expectedText).digest("hex") }];
      state = supervise(state, reply, fixtureContract);
      suppliedText = fixture.expectedText; // synthetic supervisor supplies this only after handoff
      supervisorReplies += 1;
      state = acceptObservation(state, fixture.frame(state));
    }
    if (suppliedText === null) throw new Error("Required content was not supplied");
    apply({ kind: "insert", target: fixture.target(), text: suppliedText });
  }
  if (scenario === "uncertain_hidden") state = requestHandoff(state, "unresolved_effect", "Readback cannot determine whether insertion landed");
  else {
    const evidence = state.observation!.evidenceRefs.map(ref => ({ ref, explanation: "Independent fixture goal verification" }));
    state = propose(state, fixtureDecision(state, { kind: "complete", criteria: [{ criterionId: "done", evidence }] }),
      fixtureContract, fixture.admission).state;
  }
  return { scenario, evidenceScope: "scripted_offline_contract_only", phase: state.phase,
    proposedControllerActions: controllerDecisions, supervisorReplies, receipts: state.receipts.length,
    unresolved: state.unresolved.length, actual: fixture.inspect(),
    providerCalls: 0, guiCalls: 0, modelLatency: null, modelCost: null };
}

if (import.meta.main) {
  if (process.argv.slice(2).length) throw new Error("Offline prover accepts no live/provider options");
  console.log(JSON.stringify(OFFLINE_CASES.map(runOfflineControllerProver), null, 2));
}
