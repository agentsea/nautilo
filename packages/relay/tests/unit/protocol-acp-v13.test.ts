import { describe, expect, test } from "bun:test";
import {
  ACP_RELAY_PROTOCOL_VERSION,
  ACP_RELAY_READINESS_MAX_FRAME_BYTES,
  OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  parseRelayAcpClientMessage,
  parseRelayAcpServerMessage,
  parseRelayAcpJsonFrame,
  projectRelayCapabilitiesForProtocol,
} from "../../src/index";

const scope = {
  relayId: "relay-1",
  relaySessionId: "session-1",
  desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-1",
  selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
  capabilityRevision: 2,
} as const;

describe("D452 relay ACP v13 protocol", () => {
  test("projects the two-provider capability only at v15 while preserving Hermes v13", () => {
    expect(RELAY_PROTOCOL_VERSION).toBeGreaterThanOrEqual(ACP_RELAY_PROTOCOL_VERSION);
    const current = projectRelayCapabilitiesForProtocol({
      profile: "desktop-agent", canReadWorkspace: true, canWriteWorkspace: true,
      localFileExecution: true, canRunShell: true, canUseTerminal: true,
      acp: { version: 2, hostKind: "electron", registrations: ["hermes-acp", "opencode-acp"] },
    }, RELAY_PROTOCOL_VERSION);
    expect(current.acp).toEqual({ version: 2, hostKind: "electron", registrations: ["hermes-acp", "opencode-acp"] });
    const hermesOnly = projectRelayCapabilitiesForProtocol(current, OPENCODE_ACP_RELAY_PROTOCOL_VERSION - 1);
    expect(hermesOnly.acp).toEqual({ version: 1, hostKind: "electron", registrations: ["hermes-acp"] });
    const old = projectRelayCapabilitiesForProtocol(current, 12);
    expect(old.acp).toBeUndefined();
  });

  test("accepts a canonical enabled subset and drops OpenCode-only on pre-v15 peers", () => {
    const openCodeOnly = projectRelayCapabilitiesForProtocol({
      profile: "desktop-agent", canReadWorkspace: true, canWriteWorkspace: true,
      localFileExecution: true, canRunShell: true, canUseTerminal: true,
      acp: { version: 2, hostKind: "electron", registrations: ["opencode-acp"] },
    }, RELAY_PROTOCOL_VERSION);
    expect(openCodeOnly.acp).toEqual({ version: 2, hostKind: "electron", registrations: ["opencode-acp"] });
    expect(projectRelayCapabilitiesForProtocol(openCodeOnly, 14).acp).toBeUndefined();
  });

  test("accepts the exact five-state result and rejects authority smuggling", () => {
    const result = {
      type: "relay:acp-readiness-result", requestId: "request-1", scope,
      registrationId: "hermes-acp", state: "authentication_required",
    } as const;
    expect(parseRelayAcpClientMessage(result).ok).toBe(true);
    expect(parseRelayAcpClientMessage({ ...result, executablePath: "/private/key" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ ...result, state: "maybe" }).ok).toBe(false);
    expect(parseRelayAcpClientMessage({ ...result, scope: { ...scope, selectedProtocolVersion: 12 } }).ok).toBe(false);
  });

  test("accepts only a scoped exact readiness request", () => {
    const command = {
      type: "relay:acp-readiness", requestId: "request-1", scope, registrationId: "hermes-acp",
    } as const;
    expect(parseRelayAcpServerMessage(command).ok).toBe(true);
    expect(parseRelayAcpServerMessage({ ...command, arguments: ["acp"] }).ok).toBe(false);
    expect(parseRelayAcpServerMessage({ ...command, registrationId: "opencode-acp" }).ok).toBe(true);
    expect(parseRelayAcpServerMessage({
      ...command,
      registrationId: "opencode-acp",
      scope: { ...scope, selectedProtocolVersion: OPENCODE_ACP_RELAY_PROTOCOL_VERSION - 1 },
    }).ok).toBe(false);
  });

  test("keeps readiness at its v13 8KiB pre-parse ceiling", () => {
    const raw = `{"type":"relay:acp-readiness-result","padding":"${"x".repeat(ACP_RELAY_READINESS_MAX_FRAME_BYTES)}"}`;
    expect(parseRelayAcpJsonFrame(raw, "client")).toEqual({ ok: false, error: "ACP_FRAME_INVALID" });
  });
});
