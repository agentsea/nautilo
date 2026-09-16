import { describe, expect, test } from "bun:test";
import { parseRelayEndpointClientMessage } from "../../src/realtime/relay-endpoint";

const socket = { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 15, capabilityRevision: 0 };
const binding = { bindingId: "binding-1", bindingGeneration: "1", ownerId: "owner-1", taskId: "task-1", taskRunId: "run-1", jobId: "job-1", profileId: "profile-1", profileGeneration: "1", postureId: "posture-1", postureGeneration: "1" };
const workspace = { workspaceReceiptId: "receipt-1", workspaceRevision: "1", workspaceFingerprint: "fingerprint-1", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" };
const scope = { socket, binding, workspace };

describe("D452 relay endpoint ACP v15 start-failure parsing", () => {
  test("admits only the closed OpenCode start-failure shape", () => {
    const raw = JSON.stringify({ type: "relay:acp-start-failed", registrationId: "opencode-acp", scope, stage: "initialized" });
    expect(parseRelayEndpointClientMessage(raw).ok).toBe(true);
    expect(parseRelayEndpointClientMessage(raw.slice(0, -1) + ',"error":"private"}')).toEqual({ ok: false, codex: false, error: "ACP_FRAME_INVALID" });
    expect(parseRelayEndpointClientMessage(JSON.stringify({ type: "relay:acp-start-failed", registrationId: "hermes-acp", scope, stage: "initialized" }))).toEqual({ ok: false, codex: false, error: "ACP_FRAME_INVALID" });
  });
});
