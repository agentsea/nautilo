import { describe, expect, test } from "bun:test";
import type { RelayCodexRequestMessage } from "@nautilo/relay";
import { CodexRequestProjector } from "../../src/codex/request-projector";

const scope = {
  relayId: "relay", relaySessionId: "relay-session", desktopSessionId: "desktop",
  pairingGenerationRef: "pairing", selectedProtocolVersion: 8, capabilityRevision: 1,
  profileHandle: "profile", profileGeneration: 2, accountGeneration: 3,
  runtimeGeneration: 4, childGeneration: 5,
  bindingId: "binding", bindingGeneration: 6, taskId: "task", jobId: "job",
  threadId: "thread",
  workspace: {
    workspaceRef: "workspace", revision: 1, fingerprint: "fingerprint",
    issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T01:00:00.000Z",
  },
  turnId: "turn", eventId: "event", itemId: "item", requestRef: "request",
} as const;
const EXPIRY = "2026-07-29T00:00:30.000Z";

function projector() {
  return new CodexRequestProjector({
    bindingId: "binding", bindingGeneration: "6", taskId: "task",
    roomId: "room", ownerId: "owner",
  });
}

describe("CodexRequestProjector", () => {
  test("keeps command, network, file, and permission semantics distinct", () => {
    const messages: readonly RelayCodexRequestMessage[] = [
      {
        type: "relay:codex-request", scope,
        request: {
          kind: "command_approval", choices: ["accept", "decline"],
          reason: "host_local_only", command: { detail: "host_local_only", actionKinds: ["read"] },
          expiresAt: EXPIRY,
        },
      },
      {
        type: "relay:codex-request", scope,
        request: {
          kind: "network_approval", choices: ["decline"], reason: "not_provided",
          network: { host: "api.example.test", protocol: "https" }, expiresAt: EXPIRY,
        },
      },
      {
        type: "relay:codex-request", scope,
        request: {
          kind: "file_change_approval", choices: ["accept", "acceptForSession", "decline", "cancel"],
          reason: "host_local_only", grantRoot: "host_local_only", expiresAt: EXPIRY,
        },
      },
      {
        type: "relay:codex-request", scope,
        request: {
          kind: "permissions_approval", reason: "host_local_only",
          permissions: {
            network: { enabled: true },
            fileSystem: { readPathCount: 1, writePathCount: 2, entryCount: 0, pathDetail: "host_local_only" },
          },
          expiresAt: EXPIRY,
        },
      },
    ];

    const projected = messages.map((message) => projector().project(message));
    expect(projected[0]).toMatchObject({
      kind: "command_approval_required", vendorRequestId: null,
      options: ["approve", "deny"], reason: "host_local_only",
      command: { detail: "host_local_only", actionKinds: ["read"] },
    });
    expect(projected[1]).toMatchObject({
      kind: "network_approval_required", options: ["deny"],
      network: { host: "api.example.test", protocol: "https" },
    });
    expect(projected[2]).toMatchObject({
      kind: "file_change_approval_required",
      options: ["approve", "approve_for_session", "deny", "cancel"],
      grantRoot: "host_local_only",
    });
    expect(projected[3]).toMatchObject({
      kind: "permissions_approval_required",
      permissions: {
        network: { enabled: true },
        fileSystem: { readPathCount: 1, writePathCount: 2, entryCount: 0, pathDetail: "host_local_only" },
      },
    });
  });

  test("preserves opaque input option ids and user-input automatic resolution", () => {
    const message: RelayCodexRequestMessage = {
      type: "relay:codex-request",
      scope,
      request: {
        kind: "user_input",
        questions: [{
          id: "target", header: "Target", question: "Which target?",
          isOther: true, isSecret: false,
          options: [{ id: "option:0", label: "Tests", description: "Run the focused tests." }],
        }, {
          id: "token", header: "Token", question: "Enter the token.",
          isOther: false, isSecret: true, options: null,
        }],
        autoResolutionMs: 30_000,
        expiresAt: EXPIRY,
      },
    };
    expect(projector().project(message)).toMatchObject({
      kind: "user_input_required",
      autoResolutionMs: 30_000,
      questions: [{
        id: "target", header: "Target", prompt: "Which target?",
        secret: false, multiSelect: false, allowOther: true,
        options: [{ id: "option:0", label: "Tests", description: "Run the focused tests." }],
      }, { id: "token", secret: true, multiSelect: false, options: null }],
    });
  });

  test("rejects a foreign binding without projecting a request", () => {
    const message = {
      type: "relay:codex-request",
      scope: { ...scope, bindingId: "foreign" },
      request: {
        kind: "command_approval", choices: ["decline"],
        reason: "not_provided", command: { detail: "not_provided", actionKinds: [] }, expiresAt: EXPIRY,
      },
    } as RelayCodexRequestMessage;
    expect(projector().project(message)).toBeNull();
  });

});
