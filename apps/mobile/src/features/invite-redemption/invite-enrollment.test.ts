import { describe, expect, test } from "bun:test";

import type { CeremonyRef } from "./invite-ceremony";
import {
  enrollmentFailureFromError,
  retainInviteEnrollmentFailure,
  rewindInviteAuthentication,
  runInviteEnrollment,
  validateInviteHandle,
} from "./invite-enrollment";
import type { InviteHandoffInput, InviteHandoffRecord } from "./invite-handoff";
import { NativeAuthError } from "@/lib/auth-request";

const ref: CeremonyRef = { generation: 7, serverId: "srv_invites", ceremonyId: "ceremony-7" };
const serverUrl = "https://invites.example.test";

function record(input: InviteHandoffInput): InviteHandoffRecord {
  return {
    version: 1,
    serverId: input.serverId,
    serverUrl: input.serverUrl,
    inviteToken: input.inviteToken,
    prepareState: input.prepareState,
    handle: input.handle,
    stage: input.stage,
    startedAt: input.startedAt,
    expiresAt: input.inviteExpiresAt ?? input.startedAt + 60_000,
  };
}

function previewHandoff(): InviteHandoffRecord {
  return record({
    serverId: ref.serverId,
    serverUrl,
    inviteToken: "inv_abc123",
    prepareState: null,
    handle: null,
    stage: "preview",
    startedAt: 1_000,
    inviteExpiresAt: 61_000,
  });
}

describe("invite enrollment", () => {
  test("normalizes against the canonical handle grammar", () => {
    expect(validateInviteHandle("  MARIA_7 ")).toEqual({ valid: true, handle: "maria_7" });
    expect(validateInviteHandle("7maria")).toMatchObject({ valid: false });
  });

  test("runs prepare → verified external handoff → PKCE → binding handoff → bind → profile exactly once", async () => {
    const calls: string[] = [];
    let handoff = previewHandoff();
    const result = await runInviteEnrollment({ ref, serverUrl, start: "prepare", handle: "maria_7" }, {
      isCurrent: () => true,
      loadHandoff: async () => {
        calls.push("load");
        return handoff;
      },
      saveHandoff: async (input) => {
        calls.push(`save:${input.stage}`);
        handoff = record(input);
        return handoff;
      },
      prepare: async (token, input) => {
        calls.push(`prepare:${token}:${input.handle}`);
        return { state: "opaque-state" };
      },
      authenticate: async ({ handle }) => {
        calls.push(`authenticate:${handle}`);
        return "completed";
      },
      bind: async ({ state }) => {
        calls.push(`bind:${state}`);
      },
      onPrepared: () => calls.push("prepared"),
      onAuthenticated: () => calls.push("authenticated"),
    });

    expect(result).toEqual({ kind: "bound" });
    expect(calls).toEqual([
      "load",
      "prepare:inv_abc123:maria_7",
      "save:external-auth",
      "prepared",
      "authenticate:maria_7",
      "save:binding",
      "authenticated",
      "bind:opaque-state",
      "save:profile",
    ]);
    expect(handoff).toMatchObject({ stage: "profile", prepareState: null, handle: "maria_7" });
  });

  test("a stale hosted-auth return neither binds nor overwrites a replacement handoff", async () => {
    const calls: string[] = [];
    let handoff = previewHandoff();
    const result = await runInviteEnrollment({ ref, serverUrl, start: "prepare", handle: "maria_7" }, {
      isCurrent: () => true,
      loadHandoff: async () => handoff,
      saveHandoff: async (input) => {
        calls.push(`save:${input.stage}`);
        handoff = record(input);
        return handoff;
      },
      prepare: async () => ({ state: "opaque-state" }),
      authenticate: async () => "stale",
      bind: async () => calls.push("bind"),
      onPrepared: () => calls.push("prepared"),
      onAuthenticated: () => calls.push("authenticated"),
    });

    expect(result).toEqual({ kind: "stale" });
    expect(calls).toEqual(["save:external-auth", "prepared"]);
  });

  test("resumes a verified binding handoff without launching PKCE or preparing again", async () => {
    const calls: string[] = [];
    let handoff = record({
      serverId: ref.serverId,
      serverUrl,
      inviteToken: "inv_abc123",
      prepareState: "opaque-state",
      handle: "maria_7",
      stage: "binding",
      startedAt: 1_000,
      inviteExpiresAt: 61_000,
    });
    const result = await runInviteEnrollment({ ref, serverUrl, start: "bind", handle: null }, {
      isCurrent: () => true,
      loadHandoff: async () => handoff,
      saveHandoff: async (input) => {
        calls.push(`save:${input.stage}`);
        handoff = record(input);
        return handoff;
      },
      prepare: async () => {
        calls.push("prepare");
        return { state: "should-not-run" };
      },
      authenticate: async () => {
        calls.push("authenticate");
        return "completed";
      },
      bind: async ({ state }) => calls.push(`bind:${state}`),
      onPrepared: () => calls.push("prepared"),
      onAuthenticated: () => calls.push("authenticated"),
    });

    expect(result).toEqual({ kind: "bound" });
    expect(calls).toEqual(["bind:opaque-state", "save:profile"]);
  });

  test("maps typed auth cancellation and only safe API details", () => {
    expect(enrollmentFailureFromError(new NativeAuthError("cancelled"))).toBe("auth-cancelled");
    expect(enrollmentFailureFromError(new NativeAuthError("missing-logto-config"))).toBe("server-unavailable");
    expect(enrollmentFailureFromError(new NativeAuthError("callback-error"))).toBe("server-unavailable");
    expect(enrollmentFailureFromError(new NativeAuthError("exchange-failed"))).toBe("server-unavailable");
    expect(enrollmentFailureFromError(Object.assign(new Error("handle_taken"), { status: 409 }))).toEqual({ status: 409, errorCode: "handle_taken" });
    expect(enrollmentFailureFromError(Object.assign(new Error("provider said something secret"), { status: 409 }))).toEqual({ status: 409 });
  });

  test("retains only reducer-approved enrollment failures", () => {
    expect(retainInviteEnrollmentFailure({ status: 400, errorCode: "missing_handle" }, "bind")).toBe(false);
    expect(retainInviteEnrollmentFailure({ status: 409, errorCode: "handle_taken" }, "bind")).toBe(true);
    expect(retainInviteEnrollmentFailure({ status: 401 }, "bind")).toBe(true);
    expect(retainInviteEnrollmentFailure("auth-cancelled", "authenticate")).toBe(true);
    expect(retainInviteEnrollmentFailure({ status: 422, errorCode: "invalid_state" }, "bind")).toBe(false);
  });

  test("rewinds bind 401 custody to external auth only after clearing exact registration auth", async () => {
    const calls: string[] = [];
    let handoff = record({
      serverId: ref.serverId,
      serverUrl,
      inviteToken: "inv_abc123",
      prepareState: "opaque-state",
      handle: "maria_7",
      stage: "binding",
      startedAt: 1_000,
      inviteExpiresAt: 61_000,
    });
    const result = await rewindInviteAuthentication({ ref, serverUrl }, {
      isCurrent: () => true,
      loadHandoff: async () => {
        calls.push("load");
        return handoff;
      },
      clearAuthentication: async () => {
        calls.push("clear-auth");
        return "cleared";
      },
      saveHandoff: async (input) => {
        calls.push(`save:${input.stage}`);
        handoff = record(input);
        return handoff;
      },
    });

    expect(result).toBe("rewound");
    expect(calls).toEqual(["load", "clear-auth", "save:external-auth"]);
    expect(handoff).toMatchObject({ stage: "external-auth", prepareState: "opaque-state", handle: "maria_7" });
  });

  test("does not rewrite custody when auth rewind becomes stale", async () => {
    const handoff = record({
      serverId: ref.serverId,
      serverUrl,
      inviteToken: "inv_abc123",
      prepareState: "opaque-state",
      handle: "maria_7",
      stage: "binding",
      startedAt: 1_000,
      inviteExpiresAt: 61_000,
    });
    let saved = false;
    const result = await rewindInviteAuthentication({ ref, serverUrl }, {
      isCurrent: () => true,
      loadHandoff: async () => handoff,
      clearAuthentication: async () => "stale",
      saveHandoff: async () => {
        saved = true;
        return handoff;
      },
    });

    expect(result).toBe("stale");
    expect(saved).toBe(false);
  });
});
