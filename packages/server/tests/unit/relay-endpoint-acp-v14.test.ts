import { describe, expect, test } from "bun:test";
import { ACP_RELAY_MAX_FRAME_BYTES } from "@nautilo/relay";
import { parseRelayEndpointClientMessage } from "../../src/realtime/relay-endpoint";

const socket = { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 14, capabilityRevision: 0 };
const binding = { bindingId: "binding-1", bindingGeneration: "1", ownerId: "owner-1", taskId: "task-1", taskRunId: "run-1", jobId: "job-1", profileId: "profile-1", profileGeneration: "1", postureId: "posture-1", postureGeneration: "1" };
const workspace = { workspaceReceiptId: "receipt-1", workspaceRevision: "1", workspaceFingerprint: "fingerprint-1", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" };

describe("D452 relay endpoint ACP v14 parsing", () => {
  test("admits one typed semantic event but no path or raw ACP smuggling", () => {
    const raw = JSON.stringify({ type: "relay:acp-semantic", registrationId: "hermes-acp", scope: { socket, binding, workspace }, process: { connectionId: "connection-1", processGeneration: 1, acpSessionId: "session-1", turnGeneration: 1, turnRef: "turn-1" }, capabilities: { requests: "unsupported" }, payload: { kind: "output_delta", vendorItemId: null, text: "Working" }, eventId: "event-2", eventSequence: 2 });
    expect(parseRelayEndpointClientMessage(raw).ok).toBe(true);
    expect(parseRelayEndpointClientMessage(raw.slice(0, -1) + ',"cwd":"/private/repo"}')).toEqual({ ok: false, codex: false, error: "ACP_FRAME_INVALID" });
  });

  test("rejects the v14 frame before parsing when it exceeds 256KiB", () => {
    const raw = `{"type":"relay:acp-semantic","padding":"${"x".repeat(ACP_RELAY_MAX_FRAME_BYTES)}"}`;
    expect(parseRelayEndpointClientMessage(raw)).toEqual({ ok: false, codex: false, error: "ACP_FRAME_TOO_LARGE" });
  });
});
