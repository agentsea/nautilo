import { describe, expect, test } from "bun:test";

import type { CeremonyRef, InviteCeremonyState } from "./invite-ceremony";
import { inviteCancelDestination } from "./invite-cancel";

const ref: CeremonyRef = { generation: 1, serverId: "srv_fixture", ceremonyId: "ceremony-1" };

function failure(
  code: Extract<InviteCeremonyState, { kind: "failure" }>["code"],
  retryStage: Extract<InviteCeremonyState, { kind: "failure" }>["retryStage"],
): Extract<InviteCeremonyState, { kind: "failure" }> {
  return {
    kind: "failure",
    ref,
    serverUrl: "https://alpha.example.test",
    code,
    recovery: code === "invite-expired" ? "request-new-invite" : "retry",
    retryStage,
    activationOperation: null,
    resumePreview: null,
  };
}

describe("invite cancel destination", () => {
  test("returns an established same-server Human to the app after a terminal preview failure", () => {
    expect(inviteCancelDestination(failure("invite-expired", null), {
      authStatus: "signed-in",
      activeServerId: ref.serverId,
    })).toBe("app");
  });

  test("does not treat a different server, signed-out state, or partial enrollment as established app access", () => {
    expect(inviteCancelDestination(failure("invite-expired", null), {
      authStatus: "signed-in",
      activeServerId: "srv_other",
    })).toBe("add-server");
    expect(inviteCancelDestination(failure("invite-expired", null), {
      authStatus: "signed-out",
      activeServerId: ref.serverId,
    })).toBe("add-server");
    expect(inviteCancelDestination(failure("authentication-required", "complete-profile"), {
      authStatus: "signed-in",
      activeServerId: ref.serverId,
    })).toBe("add-server");
  });

  test("preserves the existing signed-in-boundary behavior", () => {
    expect(inviteCancelDestination({
      kind: "signed-in-boundary",
      ref,
      serverUrl: "https://alpha.example.test",
      preview: { inviterHandle: null, targetRoomLabel: null, expiresAt: null },
    }, {
      authStatus: "signed-out",
      activeServerId: null,
    })).toBe("app");
  });
});
