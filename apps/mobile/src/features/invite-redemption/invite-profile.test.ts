import { describe, expect, test } from "bun:test";

import type { CeremonyRef } from "./invite-ceremony";
import {
  inviteProfileFailureFromError,
  runInviteProfileCompletion,
  validateInviteProfile,
} from "./invite-profile";
import type { InviteHandoffRecord } from "./invite-handoff";

const ref: CeremonyRef = { generation: 9, serverId: "srv_invites", ceremonyId: "ceremony-9" };
const serverUrl = "https://invites.example.test";
const profileHandoff: InviteHandoffRecord = {
  version: 1,
  serverId: ref.serverId,
  serverUrl,
  inviteToken: "inv_abc123",
  prepareState: null,
  handle: "maria_7",
  stage: "profile",
  startedAt: 1_000,
  expiresAt: 61_000,
};

describe("invite profile completion", () => {
  test("requires a trimmed display name and matching 6–8 ASCII digit PIN", () => {
    expect(validateInviteProfile("  Marina  ", "123456", "123456")).toEqual({
      valid: true, displayName: "Marina", displayNameError: null, pinError: null,
    });
    expect(validateInviteProfile("   ", "12345", "123456")).toEqual({
      valid: false, displayName: "", displayNameError: "Enter a display name.", pinError: "Use a 6–8 digit PIN.",
    });
    expect(validateInviteProfile("Marina", "123456", "123457").pinError).toBe("PIN entries don't match.");
    expect(validateInviteProfile("Marina", "１２３４５６", "１２３４５６").pinError).toBe("Use a 6–8 digit PIN.");
  });

  test("uses the exact profile handoff and canonical body without handle", async () => {
    const calls: unknown[] = [];
    const result = await runInviteProfileCompletion({
      ref,
      serverUrl,
      displayName: "Marina",
      pin: "123456",
    }, {
      isCurrent: () => true,
      loadHandoff: async (server) => {
        calls.push(server);
        return profileHandoff;
      },
      complete: async (token, body) => {
        calls.push({ token, body });
        return { recoveryCodes: ["recover-1"], landingRoomId: "room-7" };
      },
    });

    expect(result).toEqual({ kind: "completed", recoveryCodes: ["recover-1"], landingRoomId: "room-7" });
    expect(calls).toEqual([
      { serverId: ref.serverId, serverUrl },
      { token: "inv_abc123", body: { displayName: "Marina", pin: "123456" } },
    ]);
    expect(JSON.stringify(calls[1])).not.toContain("handle");
  });

  test("stale completion never exposes response material", async () => {
    let current = true;
    const result = await runInviteProfileCompletion({ ref, serverUrl, displayName: "Marina", pin: "123456" }, {
      isCurrent: () => current,
      loadHandoff: async () => profileHandoff,
      complete: async () => {
        current = false;
        return { recoveryCodes: ["recover-1"], landingRoomId: "room-7" };
      },
    });
    expect(result).toEqual({ kind: "stale" });
  });

  test("fails closed for a missing/non-profile handoff and maps only safe errors", async () => {
    const missing = await runInviteProfileCompletion({ ref, serverUrl, displayName: "Marina", pin: "123456" }, {
      isCurrent: () => true,
      loadHandoff: async () => null,
      complete: async () => ({ recoveryCodes: [], landingRoomId: null }),
    });
    expect(missing).toEqual({ kind: "failed", failure: { status: 422 } });
    expect(inviteProfileFailureFromError(Object.assign(new Error("not_bound"), { status: 409 }))).toEqual({ status: 409, errorCode: "not_bound" });
    expect(inviteProfileFailureFromError(Object.assign(new Error("raw provider error"), { status: 409 }))).toEqual({ status: 409 });
  });
});
