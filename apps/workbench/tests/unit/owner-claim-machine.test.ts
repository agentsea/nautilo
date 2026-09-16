import { describe, expect, test } from "bun:test";
import {
  createOwnerClaimMachineState,
  OWNER_CLAIM_ALLOWED_EVENT_TYPES,
  OWNER_CLAIM_AUTH_STATES,
  OWNER_CLAIM_EVENT_TYPES,
  OWNER_CLAIM_PHASES,
  transitionOwnerClaim,
  type OwnerClaimAuthState,
  type OwnerClaimEvent,
  type OwnerClaimMachineState,
  type OwnerClaimPhase,
} from "../../src/lib/owner-claim-machine";

function step(state: OwnerClaimMachineState, event: OwnerClaimEvent): OwnerClaimMachineState {
  return transitionOwnerClaim(state, event).state;
}

function commandKinds(state: OwnerClaimMachineState, event: OwnerClaimEvent): string[] {
  return transitionOwnerClaim(state, event).commands.map((command) => command.kind);
}

function stateAt(phase: OwnerClaimPhase, auth: OwnerClaimAuthState): OwnerClaimMachineState {
  return {
    ...createOwnerClaimMachineState({ auth }),
    phase,
    continuation: phase === "resume-owner" ? "resume-owner" : "new-owner",
  };
}

const EXAMPLE_EVENTS: Record<(typeof OWNER_CLAIM_EVENT_TYPES)[number], OwnerClaimEvent> = {
  "capture": { type: "capture", outcome: "captured" },
  "terminal-recovery": { type: "terminal-recovery" },
  "checkpoint": { type: "checkpoint", checkpoint: "preview" },
  "auth": { type: "auth", auth: "signed-out" },
  "preview-resolved": { type: "preview-resolved", continuation: "new-owner" },
  "preview-failed": { type: "preview-failed", reason: "failed" },
  "begin-signup": { type: "begin-signup" },
  "begin-resume": { type: "begin-resume" },
  "switch-account": { type: "switch-account" },
  "sign-out-failed": { type: "sign-out-failed" },
  "prepared": { type: "prepared", intent: "signup" },
  "prepare-failed": { type: "prepare-failed" },
  "callback": { type: "callback", outcome: "succeeded" },
  "bind-resolved": { type: "bind-resolved" },
  "bind-failed": { type: "bind-failed", reason: "failed" },
  "bind-ambiguous": { type: "bind-ambiguous" },
  "submit-profile": { type: "submit-profile" },
  "completion-resolved": { type: "completion-resolved", outcome: "recovery-ready" },
  "completion-failed": { type: "completion-failed" },
  "reobserve-resolved": { type: "reobserve-resolved", outcome: "recovery-ready" },
  "reobserve-failed": { type: "reobserve-failed" },
  "recovery-acknowledged": { type: "recovery-acknowledged" },
  "finalized": { type: "finalized" },
  "finalization-failed": { type: "finalization-failed" },
  "retry": { type: "retry" },
};

const EXPECTED_ALLOWED_EVENT_TYPES: Record<OwnerClaimPhase, readonly OwnerClaimEvent["type"][]> = {
  "capturing": ["capture", "terminal-recovery", "checkpoint", "auth"],
  "waiting-auth": ["checkpoint", "auth"],
  "previewing": ["auth", "preview-resolved", "preview-failed"],
  "new-owner": ["auth", "begin-signup", "switch-account", "sign-out-failed"],
  "resume-owner": ["auth", "begin-resume", "switch-account", "sign-out-failed"],
  "starting-auth": ["auth", "prepared", "prepare-failed"],
  "awaiting-callback": ["auth", "callback"],
  "binding": ["auth", "bind-resolved", "bind-failed", "bind-ambiguous"],
  "profile": ["auth", "begin-resume", "switch-account", "sign-out-failed", "submit-profile"],
  "completing": ["auth", "completion-resolved", "completion-failed", "reobserve-resolved", "reobserve-failed"],
  "showing-recovery": ["auth", "recovery-acknowledged"],
  "finalizing": ["auth", "finalized", "finalization-failed"],
  "finished": ["auth"],
  "recoverable": ["auth", "retry"],
};

function stateForAllowedEvent(phase: OwnerClaimPhase, eventType: OwnerClaimEvent["type"]): OwnerClaimMachineState {
  const state = stateAt(phase, "signed-out");
  if (eventType === "auth") return { ...state, auth: "unknown" };
  if (eventType === "prepared") return { ...state, authIntent: "signup" };
  if (eventType === "switch-account") return { ...state, auth: "signed-in" };
  if (eventType === "submit-profile") return { ...state, auth: "signed-in" };
  if (eventType === "retry") return { ...state, retryTarget: "preview" };
  return state;
}

describe("D508 owner-claim machine", () => {
  test("enters the explicit no-code terminal state only from the entry boundary", () => {
    const state = createOwnerClaimMachineState({ finish: "product" });
    const result = transitionOwnerClaim(state, { type: "terminal-recovery" });

    expect(result.commands).toEqual([]);
    expect(result.state).toMatchObject({
      phase: "showing-recovery",
      finish: "product",
      authIntent: null,
      recoverableReason: null,
      retryTarget: null,
    });
  });

  test("takes a new owner from capture through recovery acknowledgement to the requested guide", () => {
    let state = createOwnerClaimMachineState({ finish: "guide" });
    state = step(state, { type: "capture", outcome: "captured" });
    expect(state.phase).toBe("waiting-auth");

    expect(commandKinds(state, { type: "auth", auth: "signed-out" })).toEqual(["preview-claim"]);
    state = step(state, { type: "auth", auth: "signed-out" });
    state = step(state, { type: "preview-resolved" });
    expect(state).toMatchObject({ phase: "new-owner", continuation: "new-owner" });

    expect(commandKinds(state, { type: "begin-signup" })).toEqual(["prepare-signup"]);
    state = step(state, { type: "begin-signup" });
    expect(commandKinds(state, { type: "prepared", intent: "signup" })).toEqual(["launch-logto-signup"]);
    state = step(state, { type: "prepared", intent: "signup" });
    state = step(state, { type: "callback", outcome: "succeeded" });
    expect(state.phase).toBe("awaiting-callback");

    expect(commandKinds(state, { type: "auth", auth: "signed-in" })).toEqual(["bind-subject"]);
    state = step(state, { type: "auth", auth: "signed-in" });
    state = step(state, { type: "bind-resolved" });
    expect(state.phase).toBe("profile");
    expect(commandKinds(state, { type: "submit-profile" })).toEqual(["complete-profile"]);
    state = step(state, { type: "submit-profile" });
    state = step(state, { type: "completion-resolved", outcome: "recovery-ready" });
    expect(state.phase).toBe("showing-recovery");
    expect(commandKinds(state, { type: "recovery-acknowledged" })).toEqual(["navigate-guide"]);
    state = step(state, { type: "recovery-acknowledged" });
    state = step(state, { type: "finalized" });
    expect(state.phase).toBe("finished");
  });

  test("takes a reserved resume claim through ordinary sign-in without requesting a handle", () => {
    let state = createOwnerClaimMachineState();
    state = step(state, { type: "capture", outcome: "captured" });
    state = step(state, { type: "auth", auth: "signed-out" });
    state = step(state, { type: "preview-resolved", continuation: "resume-owner" });
    expect(state.phase).toBe("resume-owner");
    expect(commandKinds(state, { type: "begin-resume" })).toEqual(["prepare-resume"]);
    state = step(state, { type: "begin-resume" });
    expect(commandKinds(state, { type: "prepared", intent: "signin" })).toEqual(["launch-logto-signin"]);
    state = step(state, { type: "prepared", intent: "signin" });
    state = step(state, { type: "auth", auth: "signed-in" });
    expect(state.phase).toBe("binding");
    expect(commandKinds(state, { type: "auth", auth: "signed-in" })).toEqual([]);
  });

  test("prepares a fresh signed-in resume handoff before binding without another Logto launch", () => {
    let state = createOwnerClaimMachineState({ auth: "signed-in" });
    state = step(state, { type: "checkpoint", checkpoint: "preview" });
    expect(state.phase).toBe("previewing");

    expect(commandKinds(state, { type: "preview-resolved", continuation: "resume-owner" })).toEqual(["prepare-resume"]);
    state = step(state, { type: "preview-resolved", continuation: "resume-owner" });
    expect(state).toMatchObject({
      phase: "starting-auth",
      auth: "signed-in",
      continuation: "resume-owner",
      authIntent: "signin",
    });

    expect(commandKinds(state, { type: "prepared", intent: "signin" })).toEqual(["bind-subject"]);
    state = step(state, { type: "prepared", intent: "signin" });
    expect(state).toMatchObject({ phase: "binding", auth: "signed-in", authIntent: null });
  });

  test("treats an optional preview continuation as new-owner compatibility, not a legacy UI fallback", () => {
    let state = createOwnerClaimMachineState({ auth: "signed-out" });
    state = step(state, { type: "checkpoint", checkpoint: "preview" });
    state = step(state, { type: "preview-resolved" });
    expect(state).toMatchObject({ phase: "new-owner", continuation: "new-owner" });
  });

  test("does no owner operation while auth is unknown and never treats signing-in as signed-out", () => {
    let state = createOwnerClaimMachineState();
    state = step(state, { type: "capture", outcome: "captured" });
    expect(transitionOwnerClaim(state, { type: "auth", auth: "unknown" })).toMatchObject({
      disposition: "ignored",
      commands: [],
      state: { phase: "waiting-auth" },
    });
    expect(commandKinds(state, { type: "auth", auth: "signing-in" })).toEqual([]);
    state = step(state, { type: "auth", auth: "signing-in" });
    expect(state.phase).toBe("waiting-auth");
    expect(commandKinds(state, { type: "auth", auth: "signed-out" })).toEqual(["preview-claim"]);
  });

  test("preserves the callback checkpoint through signing-in and starts bind exactly once when signed-in arrives", () => {
    let state = createOwnerClaimMachineState({ auth: "signed-out" });
    state = step(state, { type: "checkpoint", checkpoint: "awaiting-bind" });
    expect(state.phase).toBe("awaiting-callback");
    state = step(state, { type: "auth", auth: "signing-in" });
    expect(state.phase).toBe("awaiting-callback");
    expect(commandKinds(state, { type: "auth", auth: "signed-in" })).toEqual(["bind-subject"]);
    state = step(state, { type: "auth", auth: "signed-in" });
    expect(state.phase).toBe("binding");
    expect(transitionOwnerClaim(state, { type: "auth", auth: "signed-in" }).disposition).toBe("ignored");
  });

  test("restores each hydrated auth checkpoint's original decision when auth is signed out", () => {
    for (const [checkpoint, phase] of [
      ["awaiting-signup", "new-owner"],
      ["awaiting-bind", "resume-owner"],
    ] as const) {
      let state = createOwnerClaimMachineState({ auth: "unknown" });
      state = step(state, { type: "checkpoint", checkpoint });
      expect(state).toMatchObject({ phase: "awaiting-callback", auth: "unknown", continuation: phase });
      expect(commandKinds(state, { type: "auth", auth: "signed-out" })).toEqual([]);
      state = step(state, { type: "auth", auth: "signed-out" });
      expect(state).toMatchObject({ phase, auth: "signed-out", continuation: phase });
    }
  });

  test("restores every valid checkpoint deterministically and makes incomplete boundary input recoverable", () => {
    const preview = step(createOwnerClaimMachineState({ auth: "signed-in" }), {
      type: "checkpoint",
      checkpoint: "preview",
    });
    expect(preview.phase).toBe("previewing");

    for (const checkpoint of ["awaiting-signup", "awaiting-bind"] as const) {
      const checkpointState = createOwnerClaimMachineState({ auth: "signed-in" });
      expect(commandKinds(checkpointState, {
        type: "checkpoint",
        checkpoint,
      })).toEqual(["bind-subject"]);
      const resumed = step(checkpointState, {
        type: "checkpoint",
        checkpoint,
      });
      expect(resumed.phase).toBe("binding");
      expect(resumed.continuation).toBe(checkpoint === "awaiting-signup" ? "new-owner" : "resume-owner");
    }

    const profile = step(createOwnerClaimMachineState({ auth: "signed-out" }), {
      type: "checkpoint",
      checkpoint: "profile",
    });
    expect(profile).toMatchObject({ phase: "profile", auth: "signed-out" });
    expect(transitionOwnerClaim(profile, { type: "submit-profile" })).toMatchObject({
      disposition: "rejected",
      reason: "auth-not-ready",
    });

    expect(step(createOwnerClaimMachineState(), { type: "checkpoint", checkpoint: "incomplete" })).toMatchObject({
      phase: "recoverable",
      recoverableReason: "checkpoint-incomplete",
    });
  });

  test("revalidates a restored profile against the first signed-in subject", () => {
    let profile = step(createOwnerClaimMachineState({ auth: "signed-out" }), {
      type: "checkpoint",
      checkpoint: "profile",
    });
    expect(commandKinds(profile, { type: "auth", auth: "unknown" })).toEqual([]);
    profile = step(profile, { type: "auth", auth: "unknown" });
    expect(profile).toMatchObject({ phase: "profile", auth: "unknown" });
    expect(commandKinds(profile, { type: "auth", auth: "signed-in" })).toEqual(["bind-subject"]);

    const binding = step(profile, { type: "auth", auth: "signed-in" });
    expect(binding).toMatchObject({ phase: "binding", auth: "signed-in" });
    expect(step(binding, { type: "bind-resolved" })).toMatchObject({ phase: "profile", auth: "signed-in" });
    expect(transitionOwnerClaim(binding, { type: "bind-failed", reason: "reserved" })).toMatchObject({
      state: {
        phase: "recoverable",
        recoverableReason: "claim-reserved",
        retryTarget: "resume-owner",
      },
    });
  });

  test("uses the right idempotent observation for ambiguous bind versus ambiguous completion", () => {
    const completing = stateAt("completing", "signed-in");
    expect(commandKinds(completing, { type: "completion-resolved", outcome: "ambiguous" })).toEqual([
      "reobserve-completion",
    ]);
    expect(commandKinds(completing, { type: "auth", auth: "signed-out" })).toEqual([
      "reobserve-completion",
    ]);
    expect(step(completing, { type: "reobserve-resolved", outcome: "pending" })).toMatchObject({
      phase: "recoverable",
      recoverableReason: "completion-pending",
      retryTarget: "completing",
    });
    const binding = stateAt("binding", "signed-in");
    expect(commandKinds(binding, { type: "bind-ambiguous" })).toEqual(["reobserve-bind"]);
    const bindRetry = step(binding, { type: "bind-failed", reason: "failed" });
    expect(bindRetry).toMatchObject({
      phase: "recoverable",
      recoverableReason: "bind-failed",
      retryTarget: "binding",
    });
    expect(commandKinds(bindRetry, { type: "retry" })).toEqual(["reobserve-bind"]);
    expect(transitionOwnerClaim(binding, { type: "auth", auth: "signed-out" })).toMatchObject({
      commands: [],
      state: { phase: "awaiting-callback", auth: "signed-out" },
    });
  });

  test("makes stale and invalid events explicit rather than falling through", () => {
    const profile = stateAt("profile", "signed-in");
    const stale = transitionOwnerClaim(profile, { type: "preview-resolved", continuation: "resume-owner" });
    expect(stale).toEqual({
      state: profile,
      commands: [],
      disposition: "ignored",
      reason: "event-not-allowed-in-phase",
    });
    expect(transitionOwnerClaim(profile, { type: "begin-signup" })).toMatchObject({
      disposition: "ignored",
      reason: "event-not-allowed-in-phase",
    });
    const signedInNewOwner = stateAt("new-owner", "signed-in");
    expect(transitionOwnerClaim(signedInNewOwner, { type: "switch-account" })).toMatchObject({
      disposition: "applied",
      commands: [{ kind: "sign-out" }],
      state: { phase: "new-owner", auth: "signed-in" },
    });
  });

  test("makes a failed account switch recoverable at the exact original decision point", () => {
    for (const phase of ["new-owner", "resume-owner", "profile"] as const) {
      const state = stateAt(phase, "signed-in");
      const failed = transitionOwnerClaim(state, { type: "sign-out-failed" });
      expect(failed).toMatchObject({
        disposition: "applied",
        state: {
          phase: "recoverable",
          recoverableReason: "authentication-failed",
          retryTarget: phase,
        },
      });
      expect(transitionOwnerClaim(failed.state, { type: "retry" })).toMatchObject({
        disposition: "applied",
        state: { phase, recoverableReason: null, retryTarget: null },
        commands: [],
      });
    }
  });

  test("is deterministic for every phase/event pair and every auth observation", () => {
    expect(OWNER_CLAIM_ALLOWED_EVENT_TYPES).toEqual(EXPECTED_ALLOWED_EVENT_TYPES);
    for (const phase of OWNER_CLAIM_PHASES) {
      for (const auth of OWNER_CLAIM_AUTH_STATES) {
        for (const eventType of OWNER_CLAIM_EVENT_TYPES) {
          const state = stateAt(phase, auth);
          const event = EXAMPLE_EVENTS[eventType];
          const first = transitionOwnerClaim(state, event);
          const second = transitionOwnerClaim(state, event);
          expect(first).toEqual(second);
          expect(OWNER_CLAIM_PHASES).toContain(first.state.phase);
          expect(["applied", "ignored", "rejected"]).toContain(first.disposition);
          if (first.disposition !== "applied") {
            expect(first.state).toBe(state);
            expect(first.commands).toEqual([]);
            expect(first.reason).toBeDefined();
          }
        }

        for (const nextAuth of OWNER_CLAIM_AUTH_STATES) {
          const state = stateAt(phase, auth);
          const first = transitionOwnerClaim(state, { type: "auth", auth: nextAuth });
          const second = transitionOwnerClaim(state, { type: "auth", auth: nextAuth });
          expect(first).toEqual(second);
          expect(OWNER_CLAIM_PHASES).toContain(first.state.phase);
        }
      }
    }
  });

  test("allows only the explicit phase/event contract and rejects all other pairs as stale", () => {
    for (const phase of OWNER_CLAIM_PHASES) {
      for (const eventType of OWNER_CLAIM_EVENT_TYPES) {
        const expectedAllowed = EXPECTED_ALLOWED_EVENT_TYPES[phase].includes(eventType);
        const result = transitionOwnerClaim(stateForAllowedEvent(phase, eventType), EXAMPLE_EVENTS[eventType]);
        if (expectedAllowed) {
          expect(result.disposition).toBe("applied");
        } else {
          expect(result).toMatchObject({
            disposition: "ignored",
            reason: "event-not-allowed-in-phase",
            commands: [],
          });
        }
      }
    }
  });

  test("keeps the pure machine free of environment owners", async () => {
    const source = await Bun.file(new URL("../../src/lib/owner-claim-machine.ts", import.meta.url)).text();
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/\b(?:window|document|localStorage|sessionStorage|fetch|setTimeout|setInterval)\s*[.(]/);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:react|api-client|use-auth|owner-claim-handoff)/);
  });
});
