import { describe, expect, test } from "bun:test";

import type { InvitePreview as ApiInvitePreview } from "@nautilo/api-client/browser";

import type { InviteCeremonyState } from "./invite-ceremony";
import {
  MAX_INVITE_ADVISORY_LENGTH,
  handoffSettlementForFailure,
  inviteScreenView,
  presentInvitePreview,
  previewExpiryEpoch,
  previewFailureFromError,
  previewFailureDecision,
  previewForCeremony,
} from "./invite-preview";

const ref = { generation: 2, serverId: "srv_invite_test", ceremonyId: "invite-2" };
const apiPreview: ApiInvitePreview = {
  kind: "server",
  inviterHandle: "casey",
  targetRoomLabel: "Nautilo Builders",
  targetAgentDisplayName: "Nautilo Guide",
  targetRoleLabel: "Member",
  expiresAt: "2030-01-01T00:00:00.000Z",
  usesRemaining: 1,
};

describe("native invite preview presentation", () => {
  test("renders conditional inviter and bounded advisory labels only", () => {
    expect(presentInvitePreview(apiPreview)).toEqual({
      inviterLine: "@casey invited you",
      advisories: [
        { label: "Room", value: "Nautilo Builders" },
        { label: "Agent", value: "Nautilo Guide" },
        { label: "Role", value: "Member" },
      ],
    });
    expect(presentInvitePreview({ ...apiPreview, inviterHandle: " UNKNOWN ", targetRoomLabel: "x".repeat(500) })).toEqual({
      inviterLine: null,
      advisories: [
        { label: "Room", value: `${"x".repeat(MAX_INVITE_ADVISORY_LENGTH - 1)}…` },
        { label: "Agent", value: "Nautilo Guide" },
        { label: "Role", value: "Member" },
      ],
    });
  });

  test("the screen consumes only the safe presentation model, never raw preview fields", () => {
    const rawWithSecrets = { ...apiPreview, inviteToken: "inv_should_never_render", message: "raw API error" } as ApiInvitePreview;
    const presentation = presentInvitePreview(rawWithSecrets);
    const state: InviteCeremonyState = {
      kind: "preview",
      ref,
      serverUrl: "https://alpha.example.test",
      preview: previewForCeremony(rawWithSecrets),
    };
    const rendered = JSON.stringify(inviteScreenView(state, presentation, null));
    expect(rendered).toContain("@casey invited you");
    expect(rendered).not.toContain("inv_should_never_render");
    expect(rendered).not.toContain("raw API error");
    expect(rendered).not.toContain("usesRemaining");
  });

  test("suppresses unknown invite author and has no authority-bearing identity fields", () => {
    const presentation = presentInvitePreview({ ...apiPreview, inviterHandle: "unknown" });
    expect(presentation.inviterLine).toBeNull();
    expect(JSON.stringify(presentation)).not.toContain("serverId");
    expect(JSON.stringify(presentation)).not.toContain("serverUrl");
  });

  test("uses a valid future preview expiry and refuses absent, invalid, or elapsed values", () => {
    const now = Date.parse("2029-12-31T00:00:00.000Z");
    expect(previewExpiryEpoch("2030-01-01T00:00:00.000Z", now)).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
    expect(previewExpiryEpoch("not-a-date", now)).toBeNull();
    expect(previewExpiryEpoch("2029-01-01T00:00:00.000Z", now)).toBeNull();
    expect(previewExpiryEpoch(null, now)).toBeNull();
  });

  test("maps API and local errors to safe reducer failures without retaining messages", () => {
    expect(previewFailureFromError({ status: 410, message: "do not expose" })).toEqual({ status: 410 });
    expect(previewFailureFromError(new TypeError("network details"))).toBe("offline");
    expect(previewFailureFromError(new Error("server body"))).toBe("server-unavailable");
  });

  test("uses the reducer's exact failure and custody mapping for every preview status", () => {
    expect(previewFailureDecision({ status: 401, message: "raw" })).toMatchObject({ code: "authentication-required", settlement: "terminal-failure" });
    expect(previewFailureDecision({ status: 404, message: "raw" })).toMatchObject({ code: "invite-not-found", settlement: "terminal-failure" });
    expect(previewFailureDecision({ status: 409, message: "raw" })).toMatchObject({ code: "invite-already-redeemed", settlement: "terminal-failure" });
    expect(previewFailureDecision({ status: 410, message: "raw" })).toMatchObject({ code: "invite-expired", settlement: "expiry" });
    expect(previewFailureDecision({ status: 422, message: "raw" })).toMatchObject({ code: "invalid-ceremony", settlement: "terminal-failure" });
    expect(previewFailureDecision({ status: 429, message: "raw" })).toMatchObject({ code: "rate-limited", settlement: "retryable-network" });
    expect(previewFailureDecision({ status: 503, message: "raw" })).toMatchObject({ code: "server-unavailable", settlement: "retryable-network" });
    expect(previewFailureDecision(new TypeError("network detail"))).toMatchObject({ code: "offline", settlement: "retryable-network" });
  });

  test("settles custody on terminal outcomes and keeps only retryable network work", () => {
    expect(handoffSettlementForFailure("offline")).toBe("retryable-network");
    expect(handoffSettlementForFailure("server-unavailable")).toBe("retryable-network");
    expect(handoffSettlementForFailure("invite-expired")).toBe("expiry");
    expect(handoffSettlementForFailure("server-mismatch")).toBe("server-mismatch");
    expect(handoffSettlementForFailure("invite-not-found")).toBe("terminal-failure");
  });

  test("renders calm mapped failures rather than raw errors", () => {
    const state: InviteCeremonyState = {
      kind: "failure",
      ref,
      serverUrl: "https://alpha.example.test",
      code: "rate-limited",
      recovery: "wait-and-retry",
      retryStage: "preview",
      activationOperation: null,
      resumePreview: null,
    };
    expect(inviteScreenView(state, null, null)).toMatchObject({
      kind: "failure", title: "Too many attempts", primaryDisabled: true, serverDomain: "alpha.example.test",
    });
  });

  test("makes a server mismatch terminal and directs the Human to a full new invite", () => {
    const state: InviteCeremonyState = {
      kind: "failure",
      ref,
      serverUrl: "https://alpha.example.test",
      code: "server-mismatch",
      recovery: "start-over",
      retryStage: null,
      activationOperation: null,
      resumePreview: null,
    };
    expect(inviteScreenView(state, null, null)).toMatchObject({
      kind: "failure", title: "Start with a new invite", primaryLabel: "Paste full invite URL", recovery: "start-over",
    });
  });

  test("keeps profile and recovery views free of handle, PIN, and recovery material", () => {
    const profile: InviteCeremonyState = {
      kind: "profile", ref, serverUrl: "https://alpha.example.test", handleReady: true,
    };
    const recovery: InviteCeremonyState = {
      kind: "recovery-acknowledgement",
      ref,
      serverUrl: "https://alpha.example.test",
      recoveryMaterialAvailable: true,
      landingRoomId: "room-42",
    };
    const rendered = JSON.stringify([
      inviteScreenView(profile, null, null),
      inviteScreenView(recovery, null, null),
    ]);
    expect(rendered).toContain("Finish setting up your account");
    expect(rendered).toContain("Save your recovery codes");
    expect(rendered).not.toContain("casey");
    expect(rendered).not.toContain("123456");
    expect(rendered).not.toContain("recover-");
    expect(rendered).not.toContain("room-42");
  });
});
