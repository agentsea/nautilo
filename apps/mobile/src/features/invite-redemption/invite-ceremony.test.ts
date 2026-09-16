import { describe, expect, test } from "bun:test";

import {
  failureFromHttpStatus,
  initialInviteCeremonyState,
  reduceInviteCeremony,
  type CeremonyRef,
  type InviteCeremonyState,
} from "./invite-ceremony";

const serverUrl = "https://invites.example.test";
const ref: CeremonyRef = { generation: 1, serverId: "srv_invites", ceremonyId: "ceremony-a" };
const newerRef: CeremonyRef = { generation: 2, serverId: "srv_other", ceremonyId: "ceremony-b" };
const preview = { inviterHandle: "marina", targetRoomLabel: "Research", expiresAt: null };

function activate(
  state: InviteCeremonyState = initialInviteCeremonyState,
  ceremonyRef: CeremonyRef = ref,
): InviteCeremonyState {
  state = reduceInviteCeremony(state, { type: "locator.accepted", ref: ceremonyRef, serverUrl });
  state = reduceInviteCeremony(state, {
    type: "server.probe.succeeded",
    ref: ceremonyRef,
    serverUrl,
    knownServer: true,
    alreadyActive: true,
  });
  return state;
}

function previewed(signedIn = false): InviteCeremonyState {
  return reduceInviteCeremony(activate(), { type: "preview.succeeded", ref, preview, signedIn });
}

describe("invite ceremony", () => {
  test("starts only a newer server-qualified ceremony and never stores a token", () => {
    const state = reduceInviteCeremony(initialInviteCeremonyState, { type: "locator.accepted", ref, serverUrl });
    expect(state).toEqual({ kind: "probing-server", ref, serverUrl });
    expect(JSON.stringify(state)).not.toContain("inv_");
    expect(reduceInviteCeremony(state, { type: "locator.accepted", ref, serverUrl })).toBe(state);
  });

  test("requires confirmation before adding an unknown exact server", () => {
    let state = reduceInviteCeremony(initialInviteCeremonyState, { type: "locator.accepted", ref, serverUrl });
    state = reduceInviteCeremony(state, {
      type: "server.probe.succeeded", ref, serverUrl, knownServer: false, alreadyActive: false,
    });
    expect(state.kind).toBe("confirm-server");
    state = reduceInviteCeremony(state, { type: "server.add.requested", ref });
    expect(state).toMatchObject({ kind: "activating-server", operation: "add", serverUrl });
  });

  test("retries a failed add as add, never silently as a server switch", () => {
    let state = reduceInviteCeremony(initialInviteCeremonyState, { type: "locator.accepted", ref, serverUrl });
    state = reduceInviteCeremony(state, {
      type: "server.probe.succeeded", ref, serverUrl, knownServer: false, alreadyActive: false,
    });
    state = reduceInviteCeremony(state, { type: "server.add.requested", ref });
    state = reduceInviteCeremony(state, { type: "server.activation.failed", ref, failure: "offline" });
    expect(state).toMatchObject({ kind: "failure", retryStage: "activate-server", activationOperation: "add" });
    state = reduceInviteCeremony(state, { type: "retry", ref });
    expect(state).toMatchObject({ kind: "activating-server", operation: "add" });
  });

  test("known non-active server is switched exactly before preview", () => {
    const state = reduceInviteCeremony(activate(initialInviteCeremonyState, ref), {
      type: "server.probe.succeeded", ref, serverUrl, knownServer: true, alreadyActive: false,
    });
    // The second probe completion is not accepted after it has already advanced.
    expect(state.kind).toBe("previewing");

    let fresh = reduceInviteCeremony(initialInviteCeremonyState, { type: "locator.accepted", ref, serverUrl });
    fresh = reduceInviteCeremony(fresh, {
      type: "server.probe.succeeded", ref, serverUrl, knownServer: true, alreadyActive: false,
    });
    expect(fresh).toMatchObject({ kind: "activating-server", operation: "switch" });
  });

  test("gates a signed-in person at an explicit switch-account boundary", () => {
    const boundary = previewed(true);
    expect(boundary.kind).toBe("signed-in-boundary");
    expect(reduceInviteCeremony(boundary, { type: "account.keep-current", ref })).toMatchObject({
      kind: "cancelled", destination: "app",
    });
    expect(reduceInviteCeremony(boundary, { type: "account.switched", ref }).kind).toBe("preview");
  });

  test("returns a handle failure to its preserved form without replaying preview", () => {
    let state = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    state = reduceInviteCeremony(state, {
      type: "prepare.failed", ref, failure: { status: 400, errorCode: "invalid_handle" },
    });
    expect(state).toMatchObject({ kind: "failure", recovery: "edit-handle", resumePreview: preview });
    state = reduceInviteCeremony(state, { type: "retry", ref });
    expect(state).toEqual({ kind: "preview", ref, serverUrl, preview });
  });

  test("runs the canonical prepare → external auth → bind → profile path", () => {
    let state = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    expect(state.kind).toBe("preparing");
    state = reduceInviteCeremony(state, { type: "prepare.succeeded", ref });
    expect(state.kind).toBe("external-auth");
    state = reduceInviteCeremony(state, { type: "auth.succeeded", ref });
    expect(state.kind).toBe("binding");
    state = reduceInviteCeremony(state, { type: "bind.succeeded", ref });
    expect(state).toMatchObject({ kind: "profile", handleReady: true });
  });

  test("keeps recovery material out of reducer state and requires acknowledgement", () => {
    let state = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    state = reduceInviteCeremony(state, { type: "prepare.succeeded", ref });
    state = reduceInviteCeremony(state, { type: "auth.succeeded", ref });
    state = reduceInviteCeremony(state, { type: "bind.succeeded", ref });
    state = reduceInviteCeremony(state, { type: "profile.submit.requested", ref });
    state = reduceInviteCeremony(state, {
      type: "profile.complete.succeeded", ref, hasRecoveryMaterial: true, landingRoomId: "room-42",
    });
    expect(state).toMatchObject({ kind: "recovery-acknowledgement", recoveryMaterialAvailable: true });
    expect(JSON.stringify(state)).not.toContain("recovery-code");
    state = reduceInviteCeremony(state, { type: "recovery.acknowledged", ref });
    expect(state).toEqual({ kind: "success", ref, landingRoomId: "room-42" });
  });

  test("fences an old async completion after another server ceremony begins", () => {
    let state = activate();
    state = reduceInviteCeremony(state, { type: "locator.accepted", ref: newerRef, serverUrl: "https://other.example.test" });
    expect(state).toMatchObject({ kind: "probing-server", ref: newerRef });
    expect(reduceInviteCeremony(state, { type: "preview.succeeded", ref, preview, signedIn: false })).toBe(state);
    expect(reduceInviteCeremony(state, {
      type: "server.probe.succeeded", ref: newerRef, serverUrl: "https://other.example.test", knownServer: true, alreadyActive: true,
    }).kind).toBe("previewing");
  });

  test("rejects a completion with the right generation but wrong server identity", () => {
    const state = activate();
    const wrongServer: CeremonyRef = { ...ref, serverId: "srv_wrong" };
    expect(reduceInviteCeremony(state, { type: "preview.succeeded", ref: wrongServer, preview, signedIn: false })).toBe(state);
  });

  test("maps every API status into an explicit recovery choice", () => {
    expect(failureFromHttpStatus(400, "prepare")).toMatchObject({ code: "invalid-request", recovery: "edit-handle" });
    expect(failureFromHttpStatus(401, "bind")).toMatchObject({ code: "authentication-required", recovery: "sign-in-again", retryStage: "authenticate" });
    expect(failureFromHttpStatus(401, "complete-profile")).toMatchObject({ code: "authentication-required", recovery: "sign-in-again", retryStage: "complete-profile" });
    expect(failureFromHttpStatus(404, "preview")).toMatchObject({ code: "invite-not-found", recovery: "request-new-invite" });
    expect(failureFromHttpStatus(409, "complete-profile")).toMatchObject({ code: "invite-already-redeemed", recovery: "request-new-invite" });
    expect(failureFromHttpStatus(410, "preview")).toMatchObject({ code: "invite-expired", recovery: "request-new-invite" });
    expect(failureFromHttpStatus(422, "bind")).toMatchObject({ code: "invalid-ceremony", recovery: "start-over" });
    expect(failureFromHttpStatus(429, "prepare")).toMatchObject({ code: "rate-limited", recovery: "wait-and-retry", retryStage: "prepare" });
    expect(failureFromHttpStatus(503, "preview")).toMatchObject({ code: "server-unavailable", recovery: "retry" });
    expect(failureFromHttpStatus(400, "complete-profile")).toMatchObject({ code: "invalid-request", recovery: "edit-profile" });
    expect(failureFromHttpStatus(409, "bind", "handle_taken")).toMatchObject({ code: "invalid-request", recovery: "edit-handle" });
    expect(failureFromHttpStatus(409, "bind", "handle_mismatch")).toMatchObject({ code: "invalid-request", recovery: "edit-handle" });
    expect(failureFromHttpStatus(409, "complete-profile", "not_bound")).toMatchObject({ code: "invalid-ceremony", recovery: "start-over" });
    expect(failureFromHttpStatus(409, "complete-profile", "handle_mismatch")).toMatchObject({ code: "invalid-ceremony", recovery: "start-over" });
    expect(failureFromHttpStatus(422, "bind", "invalid_state")).toMatchObject({ code: "invalid-ceremony", recovery: "start-over" });
  });

  test("uses API error codes in reducer transitions, not only in the mapper", () => {
    let binding = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    binding = reduceInviteCeremony(binding, { type: "prepare.succeeded", ref });
    binding = reduceInviteCeremony(binding, { type: "auth.succeeded", ref });
    expect(reduceInviteCeremony(binding, {
      type: "bind.failed", ref, failure: { status: 409, errorCode: "handle_taken" },
    })).toMatchObject({ kind: "failure", code: "invalid-request", recovery: "edit-handle" });

    let completing = reduceInviteCeremony(binding, { type: "bind.succeeded", ref });
    completing = reduceInviteCeremony(completing, { type: "profile.submit.requested", ref });
    expect(reduceInviteCeremony(completing, {
      type: "profile.complete.failed", ref, failure: { status: 409, errorCode: "not_bound" },
    })).toMatchObject({ kind: "failure", code: "invalid-ceremony", recovery: "start-over" });

    const preparing = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    expect(reduceInviteCeremony(preparing, {
      type: "prepare.failed", ref, failure: { status: 400, errorCode: "invalid_handle" },
    })).toMatchObject({ kind: "failure", code: "invalid-request", recovery: "edit-handle" });

    const profile = reduceInviteCeremony(binding, { type: "bind.succeeded", ref });
    const completingProfile = reduceInviteCeremony(profile, { type: "profile.submit.requested", ref });
    expect(reduceInviteCeremony(completingProfile, {
      type: "profile.complete.failed", ref, failure: { status: 400, errorCode: "invalid_pin" },
    })).toMatchObject({ kind: "failure", code: "invalid-request", recovery: "edit-profile" });

    const editableProfile = reduceInviteCeremony(completingProfile, {
      type: "profile.complete.failed", ref, failure: { status: 400 },
    });
    expect(reduceInviteCeremony(editableProfile, { type: "retry", ref })).toEqual({
      kind: "profile", ref, serverUrl, handleReady: true,
    });
  });

  test("makes cancellation, offline, server mismatch, and relaunch recoveries explicit", () => {
    let state = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    state = reduceInviteCeremony(state, { type: "prepare.succeeded", ref });
    expect(reduceInviteCeremony(state, { type: "auth.cancelled", ref })).toMatchObject({
      kind: "failure", code: "auth-cancelled", recovery: "resume",
    });
    const offline = reduceInviteCeremony(activate(), { type: "preview.failed", ref, failure: "offline" });
    expect(offline).toMatchObject({ kind: "failure", code: "offline", recovery: "retry", retryStage: "preview" });
    expect(reduceInviteCeremony(offline, { type: "retry", ref }).kind).toBe("previewing");
    expect(reduceInviteCeremony(activate(), { type: "server.mismatch", ref })).toMatchObject({
      kind: "failure", code: "server-mismatch", recovery: "start-over",
    });
    const probing = reduceInviteCeremony(initialInviteCeremonyState, { type: "locator.accepted", ref, serverUrl });
    expect(reduceInviteCeremony(probing, { type: "server.probe.failed", ref, failure: "server-unreachable" })).toMatchObject({
      kind: "failure", code: "server-unreachable", recovery: "verify-server",
    });
  });

  test("hydrates a fresh process only from a newer, exact-server handoff", () => {
    const resumed = reduceInviteCeremony(initialInviteCeremonyState, {
      type: "handoff.hydrated", ref, serverUrl, stage: "binding",
    });
    expect(resumed).toEqual({
      kind: "binding",
      ref,
      serverUrl,
      preview: { inviterHandle: null, targetRoomLabel: null, expiresAt: null },
    });
    expect(reduceInviteCeremony(resumed, {
      type: "handoff.hydrated", ref, serverUrl: "https://evil.example.test", stage: "profile",
    })).toBe(resumed);
    expect(reduceInviteCeremony(resumed, {
      type: "handoff.hydrated", ref: newerRef, serverUrl: "https://other.example.test", stage: "profile",
    })).toEqual({ kind: "profile", ref: newerRef, serverUrl: "https://other.example.test", handleReady: true });

    const current = reduceInviteCeremony(initialInviteCeremonyState, {
      type: "locator.accepted", ref: newerRef, serverUrl: "https://other.example.test",
    });
    expect(reduceInviteCeremony(current, {
      type: "handoff.hydrated", ref, serverUrl, stage: "binding",
    })).toBe(current);
  });

  test("retries prepare and profile completion in their failed operation", () => {
    const preparing = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    const rateLimited = reduceInviteCeremony(preparing, { type: "prepare.failed", ref, failure: "rate-limited" });
    expect(reduceInviteCeremony(rateLimited, { type: "retry", ref }).kind).toBe("preparing");

    let completing = reduceInviteCeremony(previewed(), { type: "prepare.requested", ref });
    completing = reduceInviteCeremony(completing, { type: "prepare.succeeded", ref });
    completing = reduceInviteCeremony(completing, { type: "auth.succeeded", ref });
    completing = reduceInviteCeremony(completing, { type: "bind.succeeded", ref });
    completing = reduceInviteCeremony(completing, { type: "profile.submit.requested", ref });
    const unavailable = reduceInviteCeremony(completing, {
      type: "profile.complete.failed", ref, failure: "server-unavailable",
    });
    expect(reduceInviteCeremony(unavailable, { type: "retry", ref }).kind).toBe("completing-profile");

    const reauthenticate = reduceInviteCeremony(completing, {
      type: "profile.complete.failed", ref, failure: { status: 401 },
    });
    expect(reauthenticate).toMatchObject({ recovery: "sign-in-again", retryStage: "complete-profile" });
    expect(reduceInviteCeremony(reauthenticate, { type: "retry", ref }).kind).toBe("completing-profile");
  });
});
