import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { acceptObservation, propose, proposeSupervisorAction, requestHandoff, returnFromSupervisor, settle,
  startController, stopController, supervise } from "../../scripts/fast-controller/contract";
import { createActionMatrix, resolveRoute, routingChoices, requestSchema } from "../../scripts/fast-controller/routing";
import { createControllerFixture, fixtureCheck, fixtureContract, fixtureDecision, fixtureOperation,
  fixtureResume, fixtureTask, OFFLINE_CASES, runOfflineControllerProver } from "../../scripts/fast-controller-prover";

function setup() {
  const fixture = createControllerFixture();
  const initial = startController(fixtureTask);
  const state = acceptObservation(initial, fixture.frame(initial));
  return { fixture, state };
}
function action(state: ReturnType<typeof setup>["state"], operation: unknown = { kind: "launch", application: "Fixture Editor" }) {
  return fixtureDecision(state, { kind: "act", operation, verify: [fixtureCheck] });
}
function matrixSetup() {
  const binding = { requestId: "r", requestRevision: 0, observationId: "o", authorityGeneration: "a" };
  const matrix = createActionMatrix([{ id: "launch", description: "Launch", input: fixtureOperation }],
    [{ capabilityId: "launch", arguments: { kind: "launch", application: "Fixture Editor" }, description: "Launch the editor", evidenceRefs: ["e"] }], ["e"]);
  return { binding, matrix };
}

describe("fast execution prototype: offline contract, not model or Cua acceptance", () => {
  for (const scenario of OFFLINE_CASES) test(`${scenario} reaches its independently checked outcome`, () => {
    const report = runOfflineControllerProver(scenario);
    expect(report.providerCalls).toBe(0);
    expect(report.guiCalls).toBe(0);
    expect(report.modelLatency).toBeNull();
    expect(report.phase).toBe(scenario === "uncertain_hidden" ? "handoff" : "complete");
    expect(report.actual.insertions).toBe(scenario === "direct" ? 0 : 1);
    expect(report.unresolved).toBe(scenario === "uncertain_hidden" ? 1 : 0);
    expect(report.supervisorReplies).toBe(scenario === "handoff_resume" ? 1 : 0);
    if (scenario === "direct") expect(report.proposedControllerActions).toBe(0);
    if (scenario === "surprise") expect(report.actual.dialog).toBe(false);
  });

  test("direct entry needs a request, not a big-model-authored plan", () => {
    expect(requestSchema.parse({ requestId: "r", requestRevision: 0, text: "Open the editor", relevantContext: [] }).text).toBe("Open the editor");
    const { matrix, binding } = matrixSetup();
    const result = resolveRoute({ route: "direct", operationRef: "direct_0" }, binding, binding, matrix);
    expect(result.proposal?.arguments).toEqual({ kind: "launch", application: "Fixture Editor" });
  });

  test("unbound capabilities stay available without generating target/value combinations", () => {
    const matrix = createActionMatrix([{ id: "value", description: "Set a supplied value", input: z.object({ value: z.string() }).strict() }], [], []);
    expect(matrix.capabilities).toHaveLength(1);
    expect(matrix.candidates).toHaveLength(0);
    expect(routingChoices(matrix).map(row => row.id)).toEqual(["execute", "reason", "inspect", "clarify", "judgment"]);
  });

  test("the matrix supports new adapter schemas, not an app/action whitelist", () => {
    const matrix = createActionMatrix([{ id: "custom", description: "Adapter-supplied operation", input: z.object({ amount: z.number(), mode: z.literal("custom") }).strict() }],
      [{ capabilityId: "custom", arguments: { amount: 17, mode: "custom" }, description: "A grounded custom operation", evidenceRefs: ["e"] }], ["e"]);
    expect(matrix.candidates).toHaveLength(1);
  });

  test("matrix rejects missing arguments and ungrounded references", () => {
    const capability = { id: "write", description: "Write", input: z.object({ text: z.string() }).strict() };
    expect(() => createActionMatrix([capability], [{ capabilityId: "write", arguments: {}, description: "Write", evidenceRefs: ["e"] }], ["e"])).toThrow();
    expect(() => createActionMatrix([capability], [{ capabilityId: "write", arguments: { text: "x" }, description: "Write", evidenceRefs: ["missing"] }], ["e"])).toThrow("ungrounded_proposal");
  });

  for (const changed of [{ requestRevision: 1 }, { observationId: "later" }, { authorityGeneration: "revoked" }, { requestId: "other" }]) {
    test(`stale router binding is rejected: ${Object.keys(changed)[0]}`, () => {
      const { matrix, binding } = matrixSetup();
      expect(() => resolveRoute({ route: "direct", operationRef: "direct_0" }, binding, { ...binding, ...changed }, matrix)).toThrow("stale_route");
    });
  }

  test("unknown direct operation cannot invent a call; uncertainty routes stay distinct", () => {
    const { matrix, binding } = matrixSetup();
    expect(() => resolveRoute({ route: "direct", operationRef: "shell" }, binding, binding, matrix)).toThrow("unknown_direct_operation");
    for (const missing of ["observable_state", "intent", "consequential_judgment"]) {
      expect(resolveRoute({ route: "uncertain", missing }, binding, binding, matrix).proposal).toBeNull();
    }
    expect(() => resolveRoute({ route: "execute", shell: "anything" }, binding, binding, matrix)).toThrow();
  });

  test("reject invalid model output without mutating the checkpoint", () => {
    const { state, fixture } = setup();
    const before = JSON.stringify(state);
    expect(() => propose(state, { ...action(state), injected: true }, fixtureContract, fixture.admission)).toThrow();
    expect(JSON.stringify(state)).toBe(before);
    expect(fixture.inspect().applicationRunning).toBe(false);
  });

  test("a stale decision and duplicate pending proposal cannot dispatch", () => {
    const { state, fixture } = setup();
    expect(() => propose(state, { ...action(state), observationId: "old" }, fixtureContract, fixture.admission)).toThrow("stale_decision");
    const pending = propose(state, action(state), fixtureContract, fixture.admission).state;
    expect(() => propose(pending, action(state), fixtureContract, fixture.admission)).toThrow("controller_not_deciding");
  });

  test("fresh observation permits safe reads, not uncertain insertion replay", () => {
    const fixture = createControllerFixture({ hiddenText: true, unknownInsert: true });
    let state = startController(fixtureTask);
    state = acceptObservation(state, fixture.frame(state));
    state = propose(state, action(state), fixtureContract, fixture.admission).state;
    state = fixture.execute(state);
    state = acceptObservation(state, fixture.frame(state));
    state = propose(state, action(state, { kind: "insert", target: fixture.target(), text: fixture.expectedText }), fixtureContract, fixture.admission).state;
    state = fixture.execute(state);
    const operationId = state.unresolved[0]!.operationId;
    state = acceptObservation(state, fixture.frame(state));
    state = propose(state, fixtureDecision(state, { kind: "observe", request: { kind: "state" }, question: "Did insertion land?" }), fixtureContract, fixture.admission).state;
    state = acceptObservation(state, fixture.frame(state));
    expect(() => propose(state, action(state, { kind: "insert", target: fixture.target(), text: fixture.expectedText }), fixtureContract, fixture.admission)).toThrow("unresolved_effect_conflict");
    expect(state.unresolved[0]!.operationId).toBe(operationId);
    expect(fixture.inspect().insertions).toBe(1);
  });

  test("handoff/resume preserves unresolved effects despite new plan and target", () => {
    const { fixture } = setup();
    let state = startController(fixtureTask);
    state = acceptObservation(state, fixture.frame(state));
    state = propose(state, action(state), fixtureContract, fixture.admission).state;
    state = fixture.execute(state);
    state = acceptObservation(state, fixture.frame(state));
    state = propose(state, action(state, { kind: "insert", target: fixture.target(), text: fixture.expectedText }), fixtureContract, fixture.admission).state;
    state = settle(state, { operationId: state.pending!.id, outcome: "partial" });
    state = requestHandoff(state, "unresolved_effect", "Check partial typing");
    state = supervise(state, fixtureResume(state), fixtureContract);
    expect(state.observation).toBeNull();
    expect(state.receipts).toHaveLength(2);
    state = acceptObservation(state, fixture.frame(state));
    expect(() => propose(state, action(state, { kind: "insert", target: fixture.target(), text: fixture.expectedText }), fixtureContract, fixture.admission)).toThrow("unresolved_effect_conflict");
  });

  test("confirmed action receipt alone is not whole-task completion", () => {
    const { fixture, state } = setup();
    const claims = [{ criterionId: "done", evidence: [{ ref: state.observation!.evidenceRefs[0]!, explanation: "I think it worked" }] }];
    expect(() => propose(state, fixtureDecision(state, { kind: "complete", criteria: claims }), fixtureContract, fixture.admission)).toThrow("completion_not_verified");
    const handoff = requestHandoff(state, "needs_reasoning", "Verify");
    const reply = { ...fixtureResume(handoff), resolution: { kind: "finish", criteria: claims } };
    expect(() => supervise(handoff, reply, fixtureContract)).toThrow("completion_not_verified");
  });

  test("supervisor reply is checkpoint-bound and cannot be consumed twice", () => {
    const { state } = setup();
    const handoff = requestHandoff(state, "missing_input", "Exact content?");
    const reply = fixtureResume(handoff);
    expect(() => supervise(handoff, { ...reply, baseCheckpointId: "old" }, fixtureContract)).toThrow("stale_supervisor_reply");
    const resumed = supervise(handoff, reply, fixtureContract);
    expect(resumed.delegation.revision).toBe(1);
    expect(() => supervise(resumed, reply, fixtureContract)).toThrow("supervision_not_expected");
  });

  test("supervisor can repair through the same executor then return without losing receipts", () => {
    const { state, fixture } = setup();
    const handoff = requestHandoff(state, "needs_reasoning", "Repair surface");
    let owned = supervise(handoff, { ...fixtureResume(handoff), resolution: { kind: "take_control", purpose: "Repair" } }, fixtureContract);
    expect(() => propose(owned, action(state), fixtureContract, fixture.admission)).toThrow("controller_not_deciding");
    const repair = { ...action(state), checkpointId: owned.checkpointId };
    owned = proposeSupervisorAction(owned, repair, fixtureContract, fixture.admission).state;
    expect(() => returnFromSupervisor(owned)).toThrow("supervisor_not_drained");
    owned = fixture.execute(owned);
    expect(owned.phase).toBe("supervisor");
    owned = returnFromSupervisor(owned);
    const resumed = supervise(owned, fixtureResume(owned), fixtureContract);
    expect(resumed.phase).toBe("observe");
    expect(resumed.receipts).toHaveLength(1);
    expect(resumed.observation).toBeNull();
  });

  test("Stop preserves pending facts and late settlement, and blocks dispatch", () => {
    const { state, fixture } = setup();
    const pending = propose(state, action(state), fixtureContract, fixture.admission).state;
    const stopped = stopController(pending);
    expect(stopped.pending).not.toBeNull();
    const late = settle(stopped, { operationId: pending.pending!.id, outcome: "unknown" });
    expect(late.phase).toBe("stopped");
    expect(late.unresolved).toHaveLength(1);
    expect(() => propose(late, action(state), fixtureContract, fixture.admission)).toThrow("controller_not_deciding");
    expect(() => settle(late, { operationId: pending.pending!.id, outcome: "applied" })).toThrow("receipt_not_pending");
  });

  test("unknown outcomes need grounded verification, not invented resolution", () => {
    const { state, fixture } = setup();
    const pending = propose(state, action(state), fixtureContract, fixture.admission).state;
    const unknown = settle(pending, { operationId: pending.pending!.id, outcome: "unknown" });
    const frame = fixture.frame(unknown);
    expect(() => acceptObservation(unknown, { ...frame, resolutions: [{ operationId: "wrong", outcome: "applied", evidenceRefs: frame.evidenceRefs }] })).toThrow("invalid_effect_resolution");
    expect(() => acceptObservation(unknown, { ...frame, resolutions: [{ operationId: pending.pending!.id, outcome: "applied", evidenceRefs: [] }] })).toThrow("invalid_effect_resolution");
  });

  test("generated strict schemas are available for a structured-output model", () => {
    const schema = z.toJSONSchema(fixtureContract.decision);
    expect(schema.additionalProperties).toBe(false);
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  test("resumption cannot reinstall a retired observation", () => {
    const { state } = setup();
    const retired = state.observation!;
    const handoff = requestHandoff(state, "missing_input", "Input");
    const resumed = supervise(handoff, fixtureResume(handoff), fixtureContract);
    expect(() => acceptObservation(resumed, retired)).toThrow("fresh_observation_required");
  });

  test("supervisor must ground its repair in its own fresh observation", () => {
    const { state, fixture } = setup();
    const handoff = requestHandoff(state, "needs_reasoning", "Repair");
    const owned = supervise(handoff, { ...fixtureResume(handoff), resolution: { kind: "take_control", purpose: "Repair" } }, fixtureContract);
    fixture.frame(owned); // new native snapshot expires the old one
    expect(() => proposeSupervisorAction(owned, { ...action(state), checkpointId: owned.checkpointId }, fixtureContract, fixture.admission))
      .toThrow("stale_fixture_observation");
  });
});
