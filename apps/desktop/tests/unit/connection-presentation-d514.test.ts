import { describe, expect, test } from "bun:test";
import {
  beginConnectionAttempt,
  connectionAttemptId,
  type ConnectionAction,
  type ConnectionAttemptState,
  type ConnectionErrorCode,
  type ConnectionPhase,
} from "../../electron/connection-attempt";
import { connectionFailureCopy, presentConnectionAttempt, publishConnectionPresentation, publishConnectionPresentationListener } from "../../electron/connection-presentation";

const ATTEMPT = connectionAttemptId("private-attempt-id");

function state(phase: ConnectionPhase = "transport"): ConnectionAttemptState {
  return {
    ...beginConnectionAttempt({
      attemptId: ATTEMPT, generation: 7, context: "switch",
      priorActiveScope: "https://private.active.example.test", enteredTarget: "private.target.example.test",
    }),
    phase,
    facts: {
      health: { attemptId: ATTEMPT, generation: 7, origin: "https://private.target.example.test", observedAtMs: 120 },
      auth: { attemptId: ATTEMPT, generation: 7, origin: "https://private.target.example.test", observedAtMs: 140 },
      expectedIdentity: "private-expected-fingerprint",
      observedIdentity: "private-observed-fingerprint",
    },
    validActions: ["retry", "cancel"],
  };
}

describe("D514 connection presentation", () => {
  test("publishes only to currently authorized subscribers and prunes stale or throwing senders", () => {
    const sent: number[] = [];
    const subscribers = new Map([[1, { throws: false }], [2, { throws: false }], [3, { throws: true }]]);
    const snapshot = presentConnectionAttempt({ state: state(), revision: 1 });
    publishConnectionPresentation(snapshot, subscribers, (id) => id !== 2, (subscriber, value) => {
      if (subscriber.throws) throw new Error("destroyed");
      sent.push(value.revision);
    });
    expect(sent).toEqual([1]);
    expect([...subscribers.keys()]).toEqual([1]);
  });

  test("isolates a throwing picker listener so later observers can still publish", () => {
    const snapshot = presentConnectionAttempt({ state: state(), revision: 1 });
    expect(publishConnectionPresentationListener(snapshot, () => { throw new Error("destroyed"); })).toBe(false);
    const received: number[] = [];
    publishConnectionPresentation(snapshot, new Map([[1, true]]), () => true, (_subscriber, value) => received.push(value.revision));
    expect(received).toEqual([1]);
  });

  test("maps every internal phase to a renderer-safe stable phase", () => {
    const expected: Readonly<Record<ConnectionPhase, string>> = {
      normalizing: "preparing", "downgrade-confirmation": "awaiting-downgrade-confirmation",
      transport: "contacting", readiness: "waiting-for-server", health: "verifying-server",
      identity: "verifying-identity", setup: "discovering-setup", auth: "discovering-sign-in",
      navigation: "opening-nautilo", promotion: "saving-connection", complete: "complete",
      failed: "failed", cancelled: "cancelled", mismatch: "identity-mismatch", superseded: "superseded",
    };
    for (const [phase, presentationPhase] of Object.entries(expected) as Array<[ConnectionPhase, string]>) {
      expect(presentConnectionAttempt({ state: state(phase), revision: 9 }).phase).toBe(presentationPhase);
    }
  });

  test("maps every typed error to its stable code without exposing its measurements", () => {
    const codes: readonly ConnectionErrorCode[] = [
      "invalid-target", "transport-unavailable", "readiness-unavailable", "health-unavailable",
      "identity-missing", "identity-mismatch", "setup-discovery-failed", "auth-discovery-failed",
      "unsafe-promotion-origin", "navigation-failed", "promotion-failed", "cancelled", "superseded",
    ];
    for (const code of codes) {
      const projected = presentConnectionAttempt({
        state: {
          ...state("failed"),
          error: {
            code, phase: "promotion", retrySafe: true, reducerStateChanged: true,
            pairingChange: { possible: true, actual: false },
            measured: { origin: "https://private.target.example.test", token: "private-token" },
            validActions: ["retry", "cancel"],
          },
        },
        revision: 10,
      });
      expect(projected.failureCode).toBe(code);
      expect(connectionFailureCopy(code)).not.toBe("");
      expect(JSON.stringify(projected)).not.toContain("private-token");
    }
  });

  test("explicitly maps every internal action into the renderer allow-list", () => {
    const actions: readonly ConnectionAction[] = [
      "retry", "cancel", "edit-target", "accept-identity", "wait",
      "confirm-downgrade", "resume-handoff",
    ];
    expect(presentConnectionAttempt({
      state: { ...state(), validActions: actions }, revision: 10,
    }).validActions).toEqual(actions);
  });

  test("serializes only safe facts and keeps elapsed observation non-terminal", () => {
    const projected = presentConnectionAttempt({ state: state(), revision: 11 });
    expect(projected).toEqual({
      version: 1, revision: 11, phase: "contacting", lastObservationAtMs: 140,
      retrySafe: true, validActions: ["retry", "cancel"], priorPairing: "present",
      pairingStateChange: "unchanged", failureCode: null,
      supportReceipt: null,
    });
    const serialized = JSON.stringify(projected);
    for (const secret of ["private-attempt-id", "private.target.example.test", "private.active.example.test", "private-expected-fingerprint", "private-observed-fingerprint", "private-token"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(presentConnectionAttempt({ state: { ...state(), facts: {} }, revision: 12 }).lastObservationAtMs).toBeNull();
  });

  test("distinguishes precommit certainty and fences changed or indeterminate terminals", () => {
    const precommit = presentConnectionAttempt({ state: state("failed"), revision: 13 });
    expect(precommit).toMatchObject({ pairingStateChange: "unchanged", retrySafe: true });
    const indeterminate = presentConnectionAttempt({
      state: state("failed"), revision: 14,
      terminal: { failureCode: "promotion-failed", pairingStateChange: "indeterminate" },
    });
    expect(indeterminate).toMatchObject({
      failureCode: "promotion-failed", pairingStateChange: "indeterminate", retrySafe: false, validActions: [],
    });
    const terminalActions: readonly ConnectionAction[] = ["retry", "cancel", "wait", "resume-handoff"];
    const changed = presentConnectionAttempt({
      state: { ...state("failed"), validActions: terminalActions }, revision: 15,
      terminal: { failureCode: "promotion-failed", pairingStateChange: "changed" },
    });
    expect(changed).toMatchObject({
      pairingStateChange: "changed", retrySafe: false, validActions: ["wait", "resume-handoff"],
    });
  });
});
