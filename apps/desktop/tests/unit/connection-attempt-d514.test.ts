import { describe, expect, test } from "bun:test";
import {
  beginConnectionAttempt,
  connectionAttemptId,
  DEFAULT_CONNECTION_ATTEMPT_POLICY,
  transitionConnectionAttempt,
  type ConnectionAttemptState,
  type ObservationReceipt,
} from "../../electron/connection-attempt";
import { planServerTarget } from "../../electron/server-target";

const ATTEMPT = connectionAttemptId("d514-attempt-a");

function target(input = "alpha.example.test") {
  const planned = planServerTarget(input);
  if (!planned.ok) throw new Error("fixture target must normalize");
  return planned;
}
function start(input = "alpha.example.test", attemptId = ATTEMPT): ConnectionAttemptState {
  return beginConnectionAttempt({
    attemptId, generation: 4, context: "switch", priorActiveScope: "https://active.example.test", enteredTarget: input,
  });
}
function receipt(state: ConnectionAttemptState, observedAtMs: number, origin?: string): ObservationReceipt {
  const candidate = state.facts.transport ?? state.facts.target?.candidates[0];
  if (!candidate && !origin) throw new Error("fixture must have a target");
  return { attemptId: state.attemptId, generation: state.generation, origin: origin ?? candidate?.origin ?? "", observedAtMs };
}
function advanceToIdentity(): ConnectionAttemptState {
  let state = transitionConnectionAttempt(start(), { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: target() }).state;
  state = transitionConnectionAttempt(state, { type: "transport-connected", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 1) }).state;
  state = transitionConnectionAttempt(state, { type: "readiness-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 2) }).state;
  state = transitionConnectionAttempt(state, { type: "health-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 3) }).state;
  return state;
}
function advanceToPromotion(): ConnectionAttemptState {
  let state = advanceToIdentity();
  for (const event of [
    { type: "identity-observed" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 3), expected: "a", observed: "a" },
    { type: "setup-discovered" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 4) },
    { type: "auth-discovered" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 5) },
    { type: "navigation-succeeded" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 6) },
  ]) state = transitionConnectionAttempt(state, event).state;
  return state;
}

describe("D514 connection attempt contract", () => {
  test("carries opaque attempt context and reaches promotion only through exact-origin receipts", () => {
    let state = advanceToIdentity();
    for (const event of [
      { type: "identity-observed" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 3), expected: "a", observed: "a" },
      { type: "setup-discovered" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 4) },
      { type: "auth-discovered" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 5) },
      { type: "navigation-succeeded" as const, attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 6) },
    ]) state = transitionConnectionAttempt(state, event).state;
    const committed = transitionConnectionAttempt(state, {
      type: "promoted", attemptId: ATTEMPT, generation: 4,
      receipt: { ...receipt(state, 7), committedAtMs: 7, authoritativePairingChanged: true },
    });
    expect(committed.state).toMatchObject({ phase: "complete", context: "switch", priorActiveScope: "https://active.example.test", authoritativePairingChanged: true });
  });

  test("B mismatch needs its exact receipt plus fresh B health/identity; B-to-C remains a mismatch", () => {
    let state = advanceToIdentity();
    state = transitionConnectionAttempt(state, {
      type: "identity-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 3), expected: "A", observed: "B",
    }).state;
    const mismatch = state.facts.mismatch;
    if (!mismatch) throw new Error("fixture must mismatch");
    state = transitionConnectionAttempt(state, { type: "accept-identity", attemptId: ATTEMPT, generation: 4, mismatch }).state;
    expect(state.phase).toBe("health");
    state = transitionConnectionAttempt(state, { type: "health-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 4) }).state;
    state = transitionConnectionAttempt(state, {
      type: "identity-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 4), expected: "A", observed: "B",
    }).state;
    expect(state.phase).toBe("setup");
    expect(state.facts.expectedIdentity).toBe("B");
    expect(state.facts.observedIdentity).toBe("B");
    expect(state.facts.mismatch).toBeUndefined();
    expect(state.facts.acceptedMismatch?.observedIdentity).toBe("B");

    let changed = advanceToIdentity();
    changed = transitionConnectionAttempt(changed, {
      type: "identity-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(changed, 3), expected: "A", observed: "B",
    }).state;
    const mismatchB = changed.facts.mismatch;
    if (!mismatchB) throw new Error("fixture must mismatch");
    changed = transitionConnectionAttempt(changed, { type: "accept-identity", attemptId: ATTEMPT, generation: 4, mismatch: mismatchB }).state;
    changed = transitionConnectionAttempt(changed, { type: "health-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(changed, 4) }).state;
    changed = transitionConnectionAttempt(changed, {
      type: "identity-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(changed, 4), expected: "A", observed: "C",
    }).state;
    expect(changed.error).toMatchObject({ code: "identity-mismatch", phase: "identity" });
  });

  test("only typed HTTPS transport failures unlock the local HTTP candidate", () => {
    let local = transitionConnectionAttempt(start("localhost:3001"), { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: target("localhost:3001") }).state;
    local = transitionConnectionAttempt(local, { type: "transport-failed", attemptId: ATTEMPT, generation: 4, receipt: receipt(local, 1), category: "network" }).state;
    expect(local.facts.transport).toMatchObject({ scheme: "http", reason: "local-http-fallback" });
    const certificate = transitionConnectionAttempt(
      transitionConnectionAttempt(start("localhost:3001"), { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: target("localhost:3001") }).state,
      { type: "transport-failed", attemptId: ATTEMPT, generation: 4, receipt: { attemptId: ATTEMPT, generation: 4, origin: "https://localhost:3001", observedAtMs: 1 }, category: "certificate" },
    );
    expect(certificate.state.error).toMatchObject({ code: "transport-unavailable", phase: "transport" });
    expect(certificate.state.facts.transport).toBeUndefined();
  });

  test("explicit HTTP after HTTPS evidence requires a human downgrade receipt", () => {
    const explicit = planServerTarget("http://localhost:3001", { previousVerifiedOrigin: "https://localhost:3001" });
    if (!explicit.ok) throw new Error("fixture target must normalize");
    let state = transitionConnectionAttempt(start("http://localhost:3001"), { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: explicit }).state;
    expect(state.phase).toBe("downgrade-confirmation");
    expect(transitionConnectionAttempt(state, { type: "transport-connected", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 1) }).accepted).toBe(false);
    state = transitionConnectionAttempt(state, { type: "confirm-downgrade", attemptId: ATTEMPT, generation: 4, receipt: { attemptId: ATTEMPT, generation: 4, origin: "http://localhost:3001", confirmedAtMs: 2 } }).state;
    expect(state.phase).toBe("transport");
  });

  test("duplicate, late attempt/generation, and B-origin facts cannot mutate A authority", () => {
    const state = advanceToIdentity();
    const duplicate = transitionConnectionAttempt(state, { type: "health-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 4) });
    const lateAttempt = transitionConnectionAttempt(state, { type: "identity-observed", attemptId: connectionAttemptId("other"), generation: 4, receipt: receipt(state, 3), expected: "a", observed: "a" });
    const lateGeneration = transitionConnectionAttempt(state, { type: "identity-observed", attemptId: ATTEMPT, generation: 3, receipt: receipt(state, 3), expected: "a", observed: "a" });
    const originB = transitionConnectionAttempt(state, { type: "identity-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 3, "https://b.example.test"), expected: "a", observed: "a" });
    expect(duplicate).toMatchObject({ accepted: false, stateChanged: false });
    expect(lateAttempt).toMatchObject({ reason: "late-attempt", state });
    expect(lateGeneration).toMatchObject({ reason: "late-generation", state });
    expect(originB).toMatchObject({ reason: "wrong-origin", state });
  });

  test("a stale same-origin receipt cannot advance the ordered observation chain", () => {
    let state = transitionConnectionAttempt(start(), { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: target() }).state;
    state = transitionConnectionAttempt(state, { type: "transport-connected", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 10) }).state;
    const staleReadiness = transitionConnectionAttempt(state, {
      type: "readiness-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 9),
    });
    expect(staleReadiness).toMatchObject({ accepted: false, stateChanged: false, reason: "stale-receipt", state });
    const freshReadiness = transitionConnectionAttempt(state, {
      type: "readiness-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 11),
    });
    state = freshReadiness.state;
    const staleHealth = transitionConnectionAttempt(state, {
      type: "health-observed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 10),
    });
    expect(staleHealth).toMatchObject({ accepted: false, stateChanged: false, reason: "stale-receipt", state });
  });

  test("failure truth distinguishes local reducer movement from active-pairing movement", () => {
    let state = transitionConnectionAttempt(start(), { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: target() }).state;
    const failed = transitionConnectionAttempt(state, { type: "transport-failed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 1), category: "status" });
    expect(failed).toMatchObject({ accepted: true, stateChanged: true });
    expect(failed.state.error).toMatchObject({ code: "transport-unavailable", phase: "transport", pairingChange: { possible: false, actual: false } });
    expect(failed.state.validActions).toEqual(["retry", "edit-target", "cancel"]);
    expect(transitionConnectionAttempt(state, { type: "failed", attemptId: ATTEMPT, generation: 4, code: "setup-discovery-failed" }).accepted).toBe(false);
  });

  test("promotion failure records whether handoff failed before or after durable linearization", () => {
    const before = transitionConnectionAttempt(advanceToPromotion(), {
      type: "failed", attemptId: ATTEMPT, generation: 4, code: "promotion-failed", authoritativePairingChanged: false,
    });
    expect(before.state.error).toMatchObject({ code: "promotion-failed", phase: "promotion", pairingChange: { possible: true, actual: false } });
    expect(before.state.authoritativePairingChanged).toBe(false);
    const after = transitionConnectionAttempt(advanceToPromotion(), {
      type: "failed", attemptId: ATTEMPT, generation: 4, code: "promotion-failed", authoritativePairingChanged: true,
    });
    expect(after.state.error).toMatchObject({ code: "promotion-failed", phase: "promotion", pairingChange: { possible: true, actual: true } });
    expect(after.state.authoritativePairingChanged).toBe(true);
    expect(after.state.validActions).toEqual(["resume-handoff"]);
    expect(transitionConnectionAttempt(after.state, { type: "cancel", attemptId: ATTEMPT, generation: 4 }).accepted).toBe(false);
    expect(transitionConnectionAttempt(after.state, { type: "supersede", attemptId: ATTEMPT, generation: 4 }).accepted).toBe(false);
    expect(transitionConnectionAttempt(after.state, { type: "retry", attemptId: ATTEMPT, generation: 4, nextAttemptId: connectionAttemptId("abandon-committed"), nextGeneration: 5 }).accepted).toBe(false);
    const resumed = transitionConnectionAttempt(after.state, { type: "resume-handoff", attemptId: ATTEMPT, generation: 4 });
    expect(resumed.state).toMatchObject({ phase: "promotion", authoritativePairingChanged: true, validActions: ["wait"] });
    // A later receipt cannot downgrade a committed handoff back to ordinary
    // retry/cancel recovery merely because it reports `false` itself.
    const repeatedFailure = transitionConnectionAttempt(resumed.state, {
      type: "failed", attemptId: ATTEMPT, generation: 4, code: "promotion-failed", authoritativePairingChanged: false,
    });
    expect(repeatedFailure.state).toMatchObject({
      authoritativePairingChanged: true,
      error: { pairingChange: { possible: true, actual: true } },
      validActions: ["resume-handoff"],
    });
    const resumedAgain = transitionConnectionAttempt(repeatedFailure.state, { type: "resume-handoff", attemptId: ATTEMPT, generation: 4 });
    const completed = transitionConnectionAttempt(resumedAgain.state, {
      type: "promoted", attemptId: ATTEMPT, generation: 4,
      receipt: { ...receipt(resumedAgain.state, 7), committedAtMs: 7, authoritativePairingChanged: true },
    });
    expect(completed.state).toMatchObject({ phase: "complete", authoritativePairingChanged: true });
  });

  test("cold boot can release freshly reverified existing authority without claiming a pairing change", () => {
    const coldAttempt = connectionAttemptId("cold-active");
    let state = beginConnectionAttempt({
      attemptId: coldAttempt,
      generation: 8,
      context: "cold-boot",
      priorActiveScope: "https://alpha.example.test",
      enteredTarget: "alpha.example.test",
    });
    const coldTarget = target();
    state = transitionConnectionAttempt(state, {
      type: "target-normalized", attemptId: coldAttempt, generation: 8, target: coldTarget,
    }).state;
    const observed = (at: number, origin = "https://alpha.example.test"): ObservationReceipt => ({
      attemptId: coldAttempt, generation: 8, origin, observedAtMs: at,
    });
    state = transitionConnectionAttempt(state, {
      type: "transport-connected", attemptId: coldAttempt, generation: 8, receipt: observed(1),
    }).state;
    state = transitionConnectionAttempt(state, {
      type: "readiness-observed", attemptId: coldAttempt, generation: 8, receipt: observed(2),
    }).state;
    state = transitionConnectionAttempt(state, {
      type: "health-observed", attemptId: coldAttempt, generation: 8, receipt: observed(3),
    }).state;
    const healthState = state;
    state = transitionConnectionAttempt(state, {
      type: "identity-observed", attemptId: coldAttempt, generation: 8,
      receipt: observed(3), expected: "server-a", observed: "server-a",
    }).state;
    const setupState = state;
    state = transitionConnectionAttempt(state, {
      type: "setup-discovered", attemptId: coldAttempt, generation: 8, receipt: observed(4),
    }).state;
    state = transitionConnectionAttempt(state, {
      type: "auth-discovered", attemptId: coldAttempt, generation: 8, receipt: observed(5),
    }).state;
    state = transitionConnectionAttempt(state, {
      type: "navigation-succeeded", attemptId: coldAttempt, generation: 8, receipt: observed(6),
    }).state;

    const released = transitionConnectionAttempt(state, {
      type: "released-active", attemptId: coldAttempt, generation: 8, receipt: observed(6),
    });
    expect(released.state).toMatchObject({
      phase: "complete", authoritativePairingChanged: false, validActions: [],
    });

    const wrongGeneration = transitionConnectionAttempt(state, {
      type: "released-active", attemptId: coldAttempt, generation: 7, receipt: observed(3),
    });
    expect(wrongGeneration).toMatchObject({ accepted: false, reason: "late-generation" });
    const wrongOrigin = transitionConnectionAttempt(state, {
      type: "released-active", attemptId: coldAttempt, generation: 8,
      receipt: observed(6, "https://other.nautilo.dev"),
    });
    expect(wrongOrigin).toMatchObject({ accepted: false, reason: "illegal-transition" });

    const switchState = { ...state, context: "switch" as const };
    expect(transitionConnectionAttempt(switchState, {
      type: "released-active", attemptId: coldAttempt, generation: 8, receipt: observed(6),
    })).toMatchObject({ accepted: false, reason: "illegal-transition" });
    expect(transitionConnectionAttempt(healthState, {
      type: "released-active", attemptId: coldAttempt, generation: 8, receipt: observed(3),
    })).toMatchObject({ accepted: false, reason: "illegal-transition" });
    expect(transitionConnectionAttempt(setupState, {
      type: "released-active", attemptId: coldAttempt, generation: 8, receipt: observed(3),
    })).toMatchObject({ accepted: false, reason: "illegal-transition" });
    expect(transitionConnectionAttempt({
      ...state,
      facts: {
        ...state.facts,
        acceptedMismatch: {
          observation: observed(2), expectedIdentity: "server-a", observedIdentity: "server-b",
        },
      },
    }, {
      type: "released-active", attemptId: coldAttempt, generation: 8, receipt: observed(6),
    })).toMatchObject({ accepted: false, reason: "illegal-transition" });
  });

  test("retry fences old facts with a new opaque attempt id as well as generation", () => {
    let state = transitionConnectionAttempt(start(), { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: target() }).state;
    state = transitionConnectionAttempt(state, { type: "transport-failed", attemptId: ATTEMPT, generation: 4, receipt: receipt(state, 1), category: "status" }).state;
    const next = connectionAttemptId("d514-attempt-b");
    state = transitionConnectionAttempt(state, { type: "retry", attemptId: ATTEMPT, generation: 4, nextAttemptId: next, nextGeneration: 5 }).state;
    expect(state).toMatchObject({ attemptId: next, generation: 5, phase: "normalizing", retryCount: 1 });
    expect(transitionConnectionAttempt(state, { type: "target-normalized", attemptId: ATTEMPT, generation: 4, target: target() })).toMatchObject({ accepted: false, stateChanged: false, reason: "late-attempt" });
  });

  test("policy names diagnostics/cancellation without a fabricated retry or terminal deadline", () => {
    expect(DEFAULT_CONNECTION_ATTEMPT_POLICY.retryDelay).toMatchObject({ classification: "soft" });
    expect(DEFAULT_CONNECTION_ATTEMPT_POLICY.retryDelay.milliseconds).toBeUndefined();
    expect(DEFAULT_CONNECTION_ATTEMPT_POLICY.slowObservationDiagnostic.classification).toBe("soft");
    expect(DEFAULT_CONNECTION_ATTEMPT_POLICY.cancellation.classification).toBe("hard");
    expect("connectionTimeout" in DEFAULT_CONNECTION_ATTEMPT_POLICY).toBe(false);
  });
});
