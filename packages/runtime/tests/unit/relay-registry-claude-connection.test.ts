import { describe, expect, test } from "bun:test";
import type { RelayCapabilities, RelayServerMessage } from "@nautilo/relay";
import { COMPUTER_USE_SEMANTIC_VERSION } from "@nautilo/types";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const owner = "owner-1";
const profileRef = "719f18c6-a3a9-4b8e-994a-9fa36136552e";
const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  claude: { version: 1, hostKind: "electron", registrations: ["claude-agent-sdk"] },
};

function resultFor(command: Extract<RelayServerMessage, { type: "relay:claude-connection-discover" }>) {
  return {
    type: "relay:claude-connection-discovery-result" as const,
    version: 17 as const,
    correlationId: command.correlationId,
    scope: command.scope,
    profileRef: command.profileRef,
    runtime: { state: "ready" as const, version: "2.1.235", executionQualified: true },
    account: { state: "connected" as const, apiProvider: "firstParty" as const, email: "writer@example.test" },
    catalog: { state: "complete" as const, complete: true as const, models: [] },
  };
}

describe("D452 Claude Connections relay registry", () => {
  test("publishes only after endpoint acknowledgement and coalesces one current profile request", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    const contexts: Array<string | null> = [];
    registry.onClaudeConnectionContext((_relayId, _userId, context) => contexts.push(context?.relaySessionId ?? null));
    await registry.register("relay-1", owner, capabilities, (message) => sent.push(message), 17, "desktop-1", 0, "pair-1");
    expect(contexts).toEqual([]);
    expect(registry.getClaudeConnectionContext("relay-1", owner)).toBeNull();
    await expectFailure(registry.requestClaudeConnectionDiscovery({ relayId: "relay-1", userId: owner, profileRef }), "CLAUDE_CONNECTION_UNAVAILABLE");
    expect(sent).toEqual([]);
    expect(registry.publishClaudeConnectionContext("relay-1", owner)).toBe(true);
    expect(registry.getClaudeConnectionContext("relay-1", owner)).not.toBeNull();
    expect(contexts).toHaveLength(1);
    const first = registry.requestClaudeConnectionDiscovery({ relayId: "relay-1", userId: owner, profileRef });
    const second = registry.requestClaudeConnectionDiscovery({ relayId: "relay-1", userId: owner, profileRef });
    expect(first).toBe(second);
    const command = sent.at(-1);
    expect(command?.type).toBe("relay:claude-connection-discover");
    if (command?.type !== "relay:claude-connection-discover") throw new Error("missing discovery command");
    const inbound = resultFor(command);
    expect(registry.acceptClaudeConnectionDiscoveryResult({ relayId: "relay-1", userId: owner, message: inbound })).toEqual({ ok: true });
    inbound.account.email = "mutated@example.test";
    expect((await first).account).toMatchObject({ email: "writer@example.test" });
    expect(registry.acceptClaudeConnectionDiscoveryResult({ relayId: "relay-1", userId: owner, message: resultFor(command) })).toEqual({ ok: false, error: "CLAUDE_CONNECTION_CORRELATION_REPLAY" });
  });

  test("invalidates published context and pending work on revision, replacement, and unregister", async () => {
    const registry = new InMemoryRelayRegistry();
    const contexts: Array<string | null> = [];
    registry.onClaudeConnectionContext((_relayId, _userId, context) => contexts.push(context?.relaySessionId ?? null));
    await registry.register("relay-1", owner, capabilities, () => undefined, 17, "desktop-1", 0, "pair-1");
    registry.publishClaudeConnectionContext("relay-1", owner);
    const pending = registry.requestClaudeConnectionDiscovery({ relayId: "relay-1", userId: owner, profileRef });
    expect(registry.updateCapabilities({ relayId: "relay-1", userId: owner, desktopSessionId: "desktop-1", capabilityRevision: 1, capabilities })).toEqual({ ok: true });
    await expectFailure(pending, "CLAUDE_CONNECTION_CONTEXT_STALE");
    expect(contexts.at(-1)).toBeNull();
    expect(registry.publishClaudeConnectionContext("relay-1", owner)).toBe(true);
    await registry.register("relay-1", owner, capabilities, () => undefined, 17, "desktop-1", 2, "pair-2");
    expect(contexts.at(-1)).toBeNull();
    registry.publishClaudeConnectionContext("relay-1", owner);
    await registry.unregister("relay-1");
    expect(contexts.at(-1)).toBeNull();
  });

  test("rejects unsupported transport, foreign result, and bounded timeout", async () => {
    const old = new InMemoryRelayRegistry();
    await old.register("old", owner, capabilities, () => undefined, 16, "desktop", 0, "pair");
    await expectFailure(old.requestClaudeConnectionDiscovery({ relayId: "old", userId: owner, profileRef }), "CLAUDE_CONNECTION_UNAVAILABLE");
    expect(old.updateCapabilities({
      relayId: "old", userId: owner, desktopSessionId: "desktop", capabilityRevision: 1, capabilities,
    })).toMatchObject({ ok: false });

    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", owner, capabilities, (message) => sent.push(message), 17, "desktop", 0, "pair");
    registry.publishClaudeConnectionContext("relay-1", owner);
    const pending = registry.requestClaudeConnectionDiscovery({ relayId: "relay-1", userId: owner, profileRef, timeoutMs: 1 });
    const command = sent.at(-1);
    if (command?.type !== "relay:claude-connection-discover") throw new Error("missing discovery command");
    expect(registry.acceptClaudeConnectionDiscoveryResult({ relayId: "relay-1", userId: "foreign", message: resultFor(command) })).toEqual({ ok: false, error: "CLAUDE_CONNECTION_CONTEXT_STALE" });
    await expectFailure(pending, "CLAUDE_CONNECTION_TIMEOUT");
  });

  test("stopping rejects a pending discovery and a rejected update preserves its published context", async () => {
    const registry = new InMemoryRelayRegistry();
    const semanticCapabilities: RelayCapabilities = {
      ...capabilities,
      computerUseSemanticVersion: COMPUTER_USE_SEMANTIC_VERSION,
    };
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", owner, semanticCapabilities, (message) => sent.push(message), 17, "desktop", 0, "pair");
    registry.publishClaudeConnectionContext("relay-1", owner);
    expect(registry.updateCapabilities({
      relayId: "relay-1", userId: owner, desktopSessionId: "desktop", capabilityRevision: 1,
      capabilities: { ...semanticCapabilities, profile: "device-relay" },
    })).toMatchObject({ ok: false });
    expect(registry.getClaudeConnectionContext("relay-1", owner)).not.toBeNull();
    const pending = registry.requestClaudeConnectionDiscovery({ relayId: "relay-1", userId: owner, profileRef });
    expect(sent).toHaveLength(1);
    registry.stop();
    await expectFailure(pending, "CLAUDE_CONNECTION_UNAVAILABLE");
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toMatchObject({ message });
}
