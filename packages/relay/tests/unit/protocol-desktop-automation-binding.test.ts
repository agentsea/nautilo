import { describe, expect, test } from "bun:test";
import {
  parseDesktopAutomationInvocationBinding,
  projectRelayCapabilitiesForProtocol,
  RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
  RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  type DesktopAutomationInvocationBinding,
} from "../../src/protocol";

const BINDING: DesktopAutomationInvocationBinding = {
  version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  computerUseContextId: "computer-use-context-1",
  computerUseInvocationId: "computer-invocation:fixture-1",
  originHumanId: "human-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  installationEpoch: "installation-epoch-1",
  grantGeneration: 1,
  provider: "cua",
  providerGeneration: "provider-generation-1",
  relayId: "relay-1",
  pairingGeneration: "pairing-1",
  desktopSessionId: "desktop-session-1",
};

describe("D516 desktop automation invocation binding", () => {
  test("parses the exact versioned, secret-free envelope", () => {
    expect(parseDesktopAutomationInvocationBinding(BINDING)).toEqual({
      ok: true,
      binding: BINDING,
    });
  });

  test("rejects missing, widened, malformed, and unbounded fields", () => {
    const { installationEpoch: _installationEpoch, ...missingEpoch } = BINDING;
    expect(parseDesktopAutomationInvocationBinding(undefined)).toEqual({
      ok: false,
      error: "desktop automation binding must be an exact object",
    });
    expect(parseDesktopAutomationInvocationBinding({ ...BINDING, provider: "unsupported" })).toEqual({
      ok: false,
      error: "desktop automation binding fields are invalid",
    });
    expect(parseDesktopAutomationInvocationBinding(missingEpoch)).toEqual({
      ok: false,
      error: "desktop automation binding must be an exact object",
    });
    expect(parseDesktopAutomationInvocationBinding({
      ...BINDING,
      installationEpoch: "installation\u00a0epoch",
    })).toEqual({
      ok: false,
      error: "desktop automation binding fields are invalid",
    });
    expect(parseDesktopAutomationInvocationBinding({ ...BINDING, grantGeneration: 0 })).toEqual({
      ok: false,
      error: "desktop automation binding fields are invalid",
    });
    expect(parseDesktopAutomationInvocationBinding({ ...BINDING, originRunId: "run\n1" })).toEqual({
      ok: false,
      error: "desktop automation binding fields are invalid",
    });
  });

  test("rejects obsolete v11 and v4 bindings rather than relabeling old authority", () => {
    expect(parseDesktopAutomationInvocationBinding({ ...BINDING, version: 11 })).toEqual({
      ok: false,
      error: "desktop automation binding version is unsupported",
    });
    expect(parseDesktopAutomationInvocationBinding({ ...BINDING, version: 4 })).toEqual({
      ok: false,
      error: "desktop automation binding version is unsupported",
    });
  });

  test("projects semantic Computer Use authority away from older peers atomically", () => {
    const capabilities = {
      profile: "desktop-agent" as const,
      canControlDesktop: true,
      computerUseSemanticVersion: 2 as const,
      desktopAutomation: {
        enabled: true as const,
        agentId: "agent-1",
        installationEpoch: "epoch-1",
        grantGeneration: 1,
        provider: "cua" as const,
        providerGeneration: "generation-1",
      },
    };
    expect(RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION).toBe(17);
    expect(projectRelayCapabilitiesForProtocol(capabilities, 16)).toEqual({ profile: "desktop-agent" });
    expect(projectRelayCapabilitiesForProtocol(capabilities, 17)).toEqual(capabilities);
  });

});
