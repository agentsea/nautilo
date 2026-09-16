import { describe, expect, test } from "bun:test";
import { activeComputerUseHostToolDefinitions } from "../../src/config/computer-use-catalogue/host-tool-admission";
import { buildRuntimeCapabilityTokens } from "../../src/runtime/relay-capabilities";

describe("signed Computer Use catalogue", () => {
  test("projects active Host descriptors rather than a compiled action union", () => {
    expect(activeComputerUseHostToolDefinitions().map((entry) => entry.name)).toContain("computer_observe");
  });
  test("an exact enabled same-Agent Host route makes the catalogue discoverable", () => {
    const registry = { findByCapabilityForUser: () => ["relay-1"], getCapabilities: () => ({
      profile: "desktop-agent" as const, computerUseSemanticVersion: 2 as const, canControlDesktop: true,
      desktopAutomation: { enabled: true as const, agentId: "agent-1", installationEpoch: "epoch-1", grantGeneration: 1, provider: "cua" as const, providerGeneration: "provider-1" },
    }) };
    expect(buildRuntimeCapabilityTokens(registry as never, "human-1", "agent-1")?.["canUseComputer"]).toBe(true);
  });
});
