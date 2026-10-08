import { describe, expect, test } from "bun:test";
import { RELAY_MIN_SUPPORTED_PROTOCOL_VERSION, RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import type { VerifiedLocalElectronOrigin, VerifiedPairedMobileOrigin } from "@nautilo/types";
import { createOrdinaryHostResolver } from "../../src/remote-control/ordinary-host-resolver";

const NOW = 1_800_000_000_000;
const origin: VerifiedPairedMobileOrigin = {
  kind: "paired_mobile",
  serverInstanceId: "server-1",
  serverBindingGeneration: 2,
  userId: "user-1",
  actorId: "actor-1",
  controllerInstallationId: "controller-1",
  installationGeneration: 3,
  requestId: "request-1",
};

function harness(input: {
  bindings?: Array<{ bindingId: string; pairingGeneration: string; label: string }>;
  live?: Array<{
    relayId: string;
    pairingGeneration: string;
    userId: string;
    desktopSessionId: string | null;
    protocolVersion: number;
    capabilityRevision: number;
    lastSeenAt: number;
    capabilities: { profile: string };
  }>;
  capabilities?: Record<string, Record<string, unknown>>;
  opaqueIds?: string[];
} = {}) {
  const opaqueIds = [...(input.opaqueIds ?? [])];
  return createOrdinaryHostResolver({
    pairingStore: {
      listActiveHostBindingsForController: async () => input.bindings ?? [],
    },
    registry: {
      snapshotForUser: () => input.live ?? [],
      getCapabilities: (relayId) => input.capabilities?.[relayId] ?? null,
    },
    now: () => NOW,
    newOpaqueId: () => opaqueIds.shift() ?? "opaque-id",
  });
}

function live(relayId: string, pairingGeneration: string) {
  return {
    relayId,
    pairingGeneration,
    userId: origin.userId,
    desktopSessionId: `session-${relayId}`,
    protocolVersion: RELAY_PROTOCOL_VERSION,
    capabilityRevision: 7,
    lastSeenAt: NOW,
    capabilities: { profile: "desktop-agent" },
  };
}

describe("verified ordinary-origin host resolution", () => {
  test("pins local Electron authority to its exact live launch without a mobile binding", async () => {
    const localOrigin: VerifiedLocalElectronOrigin = {
      kind: "local_electron",
      userId: origin.userId,
      actorId: origin.actorId,
      relayId: "relay-a",
      desktopSessionId: "session-relay-a",
      pairingGeneration: "generation-a",
      requestId: "request-local",
    };
    const resolver = harness({
      live: [live("relay-a", "generation-a")],
      capabilities: { "relay-a": { canRunShell: true } },
    });
    expect(await resolver.resolve({
      origin: localOrigin,
      toolCallId: "tool-local",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    })).toEqual({
      status: "selected",
      host: {
        relayId: "relay-a",
        pairingGeneration: "generation-a",
        desktopSessionId: "session-relay-a",
        capabilityRevision: 7,
      },
    });
    expect(await resolver.resolve({
      origin: { ...localOrigin, desktopSessionId: "prior-launch" },
      toolCallId: "tool-local",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    })).toEqual({ status: "unavailable" });
  });

  for (const source of ["local_electron", "paired_mobile"] as const) {
    for (const scenario of [
      { name: "supported managed peer", version: 26, capable: true, expected: "selected" },
      { name: "old shell compatibility peer", version: RELAY_MIN_SUPPORTED_PROTOCOL_VERSION, capable: true, expected: "selected" },
      { name: "below compatibility floor", version: RELAY_MIN_SUPPORTED_PROTOCOL_VERSION - 1, capable: true, expected: "unavailable" },
      { name: "missing negotiated capability", version: 26, capable: false, expected: "unavailable" },
    ] as const) {
      test(`${source} preserves ${scenario.name} independently of the newest protocol`, async () => {
        const requestOrigin: VerifiedLocalElectronOrigin | VerifiedPairedMobileOrigin = source === "paired_mobile"
          ? origin
          : { kind: "local_electron", userId: origin.userId, actorId: origin.actorId,
              relayId: "relay-a", desktopSessionId: "session-relay-a",
              pairingGeneration: "generation-a", requestId: "request-local" };
        const oldShell = scenario.name === "old shell compatibility peer";
        const capability = oldShell ? "canRunShell" : "canExecuteLocal";
        const resolver = harness({
          bindings: [{ bindingId: "binding-a", pairingGeneration: "generation-a", label: "A" }],
          live: [{ ...live("relay-a", "generation-a"), protocolVersion: scenario.version }],
          capabilities: { "relay-a": { [capability]: scenario.capable } },
        });
        const result = await resolver.resolve({ origin: requestOrigin,
          toolCallId: "tool-managed", toolName: oldShell ? "run_shell" : "exec_command", relayCapability: capability });
        expect(result.status).toBe(scenario.expected);
        if (scenario.expected === "selected") {
          expect(result).toMatchObject({ host: { relayId: "relay-a", desktopSessionId: "session-relay-a",
            pairingGeneration: "generation-a", capabilityRevision: 7 } });
        }
      });
    }
  }

  test("returns stable unavailable for no exact capability-bearing live binding", async () => {
    const resolver = harness({
      bindings: [{ bindingId: "binding-a", pairingGeneration: "generation-a", label: "A" }],
      live: [live("relay-a", "generation-a")],
      capabilities: { "relay-a": { canReadWorkspace: false } },
    });
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canReadWorkspace",
    })).toEqual({ status: "unavailable" });
  });

  test("selects the only exact eligible paired host", async () => {
    const capabilities = {
      canRunShell: true,
      workspaceRoot: "/path/to/workspace",
      currentFolderRoot: "/path/to/current-project",
    };
    const resolver = harness({
      bindings: [{ bindingId: "binding-a", pairingGeneration: "generation-a", label: "A" }],
      live: [live("relay-a", "generation-a")],
      capabilities: { "relay-a": capabilities },
    });
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    })).toEqual({
      status: "selected",
      host: {
        relayId: "relay-a",
        bindingId: "binding-a",
        pairingGeneration: "generation-a",
        desktopSessionId: "session-relay-a",
        capabilityRevision: 7,
        workspaceRoot: "/path/to/workspace",
        currentFolderRoot: "/path/to/current-project",
      },
    });

    capabilities.currentFolderRoot = "/path/to/other-project";
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    })).toEqual({ status: "unavailable" });
  });

  test("does not guess when several exact paired hosts are eligible", async () => {
    const resolver = harness({
      bindings: [
        { bindingId: "binding-a", pairingGeneration: "generation-a", label: "A" },
        { bindingId: "binding-b", pairingGeneration: "generation-b", label: "B" },
      ],
      live: [live("relay-a", "generation-a"), live("relay-b", "generation-b")],
      capabilities: {
        "relay-a": { canRunShell: true },
        "relay-b": { canRunShell: true },
      },
      opaqueIds: ["choice-1", "selector-a", "selector-b"],
    });
    const challenge = await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    });
    expect(challenge).toEqual({
      status: "choice_required",
      choiceId: "choice-1",
      options: [
        { selector: "selector-a", label: "A" },
        { selector: "selector-b", label: "B" },
      ],
    });
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    })).toEqual(challenge);
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
      choice: { choiceId: "choice-1", selector: "selector-b" },
    })).toMatchObject({ status: "selected", host: { relayId: "relay-b" } });
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    })).toMatchObject({ status: "selected", host: { relayId: "relay-b" } });
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
      choice: { choiceId: "choice-1", selector: "selector-b" },
    })).toEqual({ status: "unavailable" });
  });

  test("duplicate live matches for one pairing generation fail closed", async () => {
    const resolver = harness({
      bindings: [{ bindingId: "binding-a", pairingGeneration: "generation-a", label: "A" }],
      live: [live("relay-a", "generation-a"), live("relay-impostor", "generation-a")],
      capabilities: {
        "relay-a": { canRunShell: true },
        "relay-impostor": { canRunShell: true },
      },
    });
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "run_shell",
      relayCapability: "canRunShell",
    })).toEqual({ status: "unavailable" });
  });

  test("hosted local MCP cannot escape its paired owning Relay", async () => {
    const resolver = harness({
      bindings: [{ bindingId: "binding-a", pairingGeneration: "generation-a", label: "A" }],
      live: [live("relay-a", "generation-a")],
      capabilities: { "relay-a": { canReadWorkspace: true } },
    });
    expect(await resolver.resolve({
      origin,
      toolCallId: "tool-1",
      toolName: "local_mcp_tool",
      relayCapability: "canReadWorkspace",
      hostedBy: "relay-b",
    })).toEqual({ status: "unavailable" });
  });
});
