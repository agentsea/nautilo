import { describe, expect, test } from "bun:test";
import {
  parseRelayAcpClientMessage,
  parseRelayAcpServerMessage,
} from "../../src/index";

const socket = {
  relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-1", selectedProtocolVersion: 15, capabilityRevision: 3,
} as const;
const binding = {
  bindingId: "binding-1", bindingGeneration: "binding-generation-1", ownerId: "owner-1",
  taskId: "task-1", taskRunId: "run-1", jobId: "job-1", profileId: "profile-1",
  profileGeneration: "profile-generation-1", postureId: "posture-1", postureGeneration: "posture-generation-1",
} as const;
const workspace = {
  workspaceReceiptId: "receipt-1", workspaceRevision: "revision-1", workspaceFingerprint: "fingerprint-1",
  workspaceExpiresAt: "2030-01-01T00:00:00.000Z",
} as const;
const scope = { socket, binding, workspace } as const;
const process = {
  connectionId: "connection-1", processGeneration: 1, acpSessionId: "session-1",
  turnGeneration: 1, turnRef: "turn-1",
} as const;

describe("D452 relay ACP v15 provider-aware execution", () => {
  test("admits the exact OpenCode lifecycle on a v15 socket", () => {
    expect(parseRelayAcpServerMessage({ type: "relay:acp-prepare", requestId: "prepare-1", registrationId: "opencode-acp", scope: socket, binding }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-prepared", requestId: "prepare-1", registrationId: "opencode-acp", scope: socket, binding, workspace }).ok).toBe(true);
    for (const executionProfile of ["interactive", "autonomous", "plan"] as const) {
      expect(parseRelayAcpServerMessage({ type: "relay:acp-start", registrationId: "opencode-acp", scope, prompt: "work", executionProfile }).ok).toBe(true);
    }
    expect(parseRelayAcpClientMessage({ type: "relay:acp-start-failed", registrationId: "opencode-acp", scope, stage: "initialized" }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-started", registrationId: "opencode-acp", scope, process, capabilities: { requests: "unsupported" }, eventId: "event-1", eventSequence: 1 }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process, capabilities: { requests: "unsupported" }, payload: { kind: "output_delta", vendorItemId: null, text: "working" }, eventId: "event-2", eventSequence: 2 }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process, capabilities: { requests: "unsupported" }, payload: { kind: "runtime_status", state: "possibly_stalled" }, eventId: "event-health", eventSequence: 3 }).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-terminal", registrationId: "opencode-acp", scope, process, status: "completed", eventId: "event-3", eventSequence: 3 }).ok).toBe(true);
    expect(parseRelayAcpServerMessage({ type: "relay:acp-contain", registrationId: "opencode-acp", containmentRef: "contain-1", scope, process, code: "upstream_failure" }).ok).toBe(true);
  });

  test("requires the sealed OpenCode profile and preserves the exact Hermes start shape", () => {
    const openCode = { type: "relay:acp-start", registrationId: "opencode-acp", scope, prompt: "work" } as const;
    expect(parseRelayAcpServerMessage(openCode).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ ...openCode, executionProfile: "unrestricted" }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ ...openCode, executionProfile: "interactive", provider: "secret" }).ok).toBe(false);

    const hermes = { type: "relay:acp-start", registrationId: "hermes-acp", scope, prompt: "work" } as const;
    expect(parseRelayAcpServerMessage(hermes).ok).toBe(true);
    expect(parseRelayAcpServerMessage({ ...hermes, executionProfile: "interactive" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-start-failed", registrationId: "hermes-acp", scope, stage: "initialized" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-start-failed", registrationId: "opencode-acp", scope, stage: "initialized", error: "private" }).ok).toBe(false);
  });

  test("rejects every OpenCode execution frame below v15", () => {
    const oldSocket = { ...socket, selectedProtocolVersion: 14 };
    const oldScope = { ...scope, socket: oldSocket };
    expect(parseRelayAcpServerMessage({ type: "relay:acp-prepare", requestId: "prepare-1", registrationId: "opencode-acp", scope: oldSocket, binding }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-prepared", requestId: "prepare-1", registrationId: "opencode-acp", scope: oldSocket, binding, workspace }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ type: "relay:acp-start", registrationId: "opencode-acp", scope: oldScope, prompt: "work", executionProfile: "interactive" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-started", registrationId: "opencode-acp", scope: oldScope, process, capabilities: { requests: "unsupported" }, eventId: "event-1", eventSequence: 1 }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-start-failed", registrationId: "opencode-acp", scope: oldScope, stage: "initialized" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope: oldScope, process, capabilities: { requests: "unsupported" }, payload: { kind: "output_delta", vendorItemId: null, text: "working" }, eventId: "event-2", eventSequence: 2 }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope: oldScope, process, capabilities: { requests: "unsupported" }, payload: { kind: "runtime_status", state: "possibly_stalled" }, eventId: "event-health", eventSequence: 3 }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ type: "relay:acp-terminal", registrationId: "opencode-acp", scope: oldScope, process, status: "completed", eventId: "event-3", eventSequence: 3 }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ type: "relay:acp-contain", registrationId: "opencode-acp", containmentRef: "contain-1", scope: oldScope, process, code: "upstream_failure" }).ok).toBe(false);
  });

  test("accepts only the closed v15 OpenCode runtime-status shape", () => {
    const frame = { type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process, capabilities: { requests: "unsupported" }, payload: { kind: "runtime_status", state: "healthy" }, eventId: "event-health", eventSequence: 2 } as const;
    expect(parseRelayAcpClientMessage(frame).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ ...frame, registrationId: "hermes-acp" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ ...frame, payload: { kind: "runtime_status", state: "unknown" } }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ ...frame, payload: { kind: "runtime_status", state: "healthy", cpuTimeMs: 1 } }).ok).toBe(false);
  });
});
