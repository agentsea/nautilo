import { describe, expect, test } from "bun:test";
import {
  ACP_RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  parseRelayAcpClientMessage,
  parseRelayAcpJsonFrame,
  parseRelayAcpServerMessage,
} from "../../src/index";

const socket = { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: RELAY_PROTOCOL_VERSION, capabilityRevision: 2 } as const;
const binding = { bindingId: "binding-1", bindingGeneration: "1", ownerId: "owner-1", taskId: "task-1", taskRunId: "run-1", jobId: "job-1", profileId: "profile-1", profileGeneration: "1", postureId: "posture-1", postureGeneration: "1" } as const;
const workspace = { workspaceReceiptId: "receipt-1", workspaceRevision: "1", workspaceFingerprint: "fingerprint-1", workspaceExpiresAt: "2030-01-01T00:00:00.000Z" } as const;
const scope = { socket, binding, workspace } as const;
const process = { connectionId: "connection-1", processGeneration: 1, acpSessionId: "session-1", turnGeneration: 1, turnRef: "turn-1" } as const;

describe("D452 relay ACP v14 execution transport", () => {
  test("admits the exact prepare/start lifecycle and semantic terminal frames", () => {
    expect(parseRelayAcpServerMessage({ type: "relay:acp-prepare", requestId: "prepare-1", registrationId: "hermes-acp", scope: socket, binding }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-prepared", requestId: "prepare-1", registrationId: "hermes-acp", scope: socket, binding, workspace }).ok).toBe(true);
    expect(parseRelayAcpServerMessage({ type: "relay:acp-start", registrationId: "hermes-acp", scope, prompt: "edit one file" }).ok).toBe(true);
    expect(parseRelayAcpServerMessage({ type: "relay:acp-contain", registrationId: "hermes-acp", containmentRef: "contain-1", scope, process, code: "upstream_failure" }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-started", registrationId: "hermes-acp", scope, process, capabilities: { requests: "supported" }, eventId: "event-1", eventSequence: 1 }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-semantic", registrationId: "hermes-acp", scope, process, capabilities: { requests: "supported" }, payload: { kind: "command_summary", vendorItemId: "tool-1", commands: [{ summary: "Edit file", status: "completed" }] }, eventId: "event-2", eventSequence: 2 }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-terminal", registrationId: "hermes-acp", scope, process, status: "completed", eventId: "event-3", eventSequence: 3 }).ok).toBe(true);
  });

  test("rejects paths, raw ACP, permissions, Stop, stale protocol, and malformed terminal authority", () => {
    const start = { type: "relay:acp-start", registrationId: "hermes-acp", scope, prompt: "x" } as const;
    expect(parseRelayAcpServerMessage({ ...start, cwd: "/private/repo" }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ ...start, env: { SECRET: "x" } }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ ...start, message: { jsonrpc: "2.0" } }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ ...start, type: "relay:acp-stop" }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ type: "relay:acp-contain", registrationId: "hermes-acp", containmentRef: "contain-1", scope, process, code: "user_stop" }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ type: "relay:acp-contain", registrationId: "hermes-acp", containmentRef: "contain-1", scope: { ...scope, socket: { ...socket, selectedProtocolVersion: 13 } }, process, code: "upstream_failure", error: "private" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-semantic", registrationId: "hermes-acp", scope: { ...scope, socket: { ...socket, selectedProtocolVersion: 13 } }, process, capabilities: { requests: "supported" }, payload: { kind: "permission_selection_required" }, eventId: "event-2", eventSequence: 2 }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-terminal", registrationId: "hermes-acp", scope, process, status: "interrupted", eventId: "event-3", eventSequence: 3 }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-semantic", registrationId: "hermes-acp", scope, process, capabilities: { requests: "supported" }, payload: { kind: "output_delta", vendorItemId: null, text: "x" }, eventSequence: 2 }).ok).toBe(false);
  });

  test("rejects a frame over the 256KiB pre-parse cap", () => {
    const raw = `{"type":"relay:acp-start","pad":"${"x".repeat(ACP_RELAY_MAX_FRAME_BYTES)}"}`;
    expect(parseRelayAcpJsonFrame(raw, "server")).toEqual({ ok: false, error: "ACP_FRAME_INVALID" });
  });
});
