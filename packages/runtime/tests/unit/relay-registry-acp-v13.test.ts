import { describe, expect, test } from "bun:test";
import type { RelayCapabilities, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const capabilities: RelayCapabilities = {
  profile: "desktop-agent",
  acp: { version: 1, hostKind: "electron", registrations: ["hermes-acp"] },
};
const multiProviderCapabilities: RelayCapabilities = {
  profile: "desktop-agent",
  acp: { version: 2, hostKind: "electron", registrations: ["hermes-acp", "opencode-acp"] },
};

describe("D452 InMemoryRelayRegistry ACP v13 readiness", () => {
  test("sends an exact, authenticated socket request and resolves only its exact reply", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 13, "desktop-1", 2, "pairing-row-1");
    const ready = registry.requestAcpReadiness({
      relayId: "relay-1", userId: "owner-1", requestId: "request-1", registrationId: "hermes-acp",
    });
    expect(sent).toHaveLength(1);
    const command = sent[0]!;
    expect(command.type).toBe("relay:acp-readiness");
    if (command.type !== "relay:acp-readiness") throw new Error("missing ACP command");
    expect(registry.acceptAcpMessage({
      relayId: "relay-1", userId: "owner-1",
      message: { ...command, type: "relay:acp-readiness-result", state: "ready" },
    })).toEqual({ ok: true });
    expect(await ready).toBe("ready");
  });

  test("rejects stale generation results and allows a later exact retry", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", capabilities, (message) => sent.push(message), 13, "desktop-1", 0, "pairing-row-1");
    const first = registry.requestAcpReadiness({ relayId: "relay-1", userId: "owner-1", requestId: "first", registrationId: "hermes-acp" });
    const command = sent[0]!;
    if (command.type !== "relay:acp-readiness") throw new Error("missing ACP command");
    await registry.register("relay-1", "owner-1", capabilities, () => {}, 13, "desktop-1", 1, "pairing-row-2");
    let failure: unknown;
    try { await first; } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "ACP_CONTEXT_STALE" });
    expect(registry.acceptAcpMessage({
      relayId: "relay-1", userId: "owner-1",
      message: { ...command, type: "relay:acp-readiness-result", state: "ready" },
    })).toEqual({ ok: false, error: "ACP_CONTEXT_STALE" });
  });

  test("cleans pending readiness by stored relay identity, not a substring in another scope", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-a", "owner-1", capabilities, (message) => sent.push(message), 13, "desktop-a", 0, "pair-a");
    // The old substring cleanup would mistakenly treat this opaque pairing
    // reference as relay-a's key when relay-a disconnects.
    await registry.register("relay-b", "owner-1", capabilities, (message) => sent.push(message), 13, "desktop-b", 0, 'opaque-relayId="relay-a"');
    const first = registry.requestAcpReadiness({ relayId: "relay-a", userId: "owner-1", requestId: "first", registrationId: "hermes-acp" });
    const second = registry.requestAcpReadiness({ relayId: "relay-b", userId: "owner-1", requestId: "second", registrationId: "hermes-acp" });
    await registry.unregister("relay-a");
    let firstFailure: unknown;
    try { await first; } catch (error) { firstFailure = error; }
    expect(firstFailure).toMatchObject({ message: "ACP_RELAY_UNAVAILABLE" });
    const command = sent.find((message) => message.type === "relay:acp-readiness" && message.requestId === "second");
    if (!command || command.type !== "relay:acp-readiness") throw new Error("missing second ACP request");
    expect(registry.acceptAcpMessage({
      relayId: "relay-b", userId: "owner-1",
      message: { ...command, type: "relay:acp-readiness-result", state: "ready" },
    })).toEqual({ ok: true });
    expect(await second).toBe("ready");
  });

  test("rejects malformed ids, invalid timeouts, and a throwing relay send without retaining work", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "owner-1", capabilities, () => { throw new Error("socket gone"); }, 13, "desktop-1", 0, "pair-1");
    await expectFailure(registry.requestAcpReadiness({ relayId: "relay-1", userId: "owner-1", requestId: "bad\0id", registrationId: "hermes-acp" }), "ACP_REQUEST_INVALID");
    await expectFailure(registry.requestAcpReadiness({ relayId: "relay-1", userId: "owner-1", requestId: "too-slow", registrationId: "hermes-acp", timeoutMs: 10_001 }), "ACP_REQUEST_INVALID");
    await expectFailure(registry.requestAcpReadiness({ relayId: "relay-1", userId: "owner-1", requestId: "send", registrationId: "hermes-acp" }), "ACP_RELAY_UNAVAILABLE");
  });

  test("routes OpenCode readiness only through an advertised v15 exact session", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "owner-1", multiProviderCapabilities, (message) => sent.push(message), 15, "desktop-1", 0, "pair-1");
    const ready = registry.requestAcpReadiness({
      relayId: "relay-1", userId: "owner-1", requestId: "opencode", registrationId: "opencode-acp",
    });
    const command = sent[0];
    expect(command).toMatchObject({ type: "relay:acp-readiness", registrationId: "opencode-acp" });
    if (command?.type !== "relay:acp-readiness") throw new Error("missing OpenCode readiness request");
    expect(registry.acceptAcpMessage({
      relayId: "relay-1", userId: "owner-1",
      message: { ...command, type: "relay:acp-readiness-result", state: "ready" },
    })).toEqual({ ok: true });
    expect(await ready).toBe("ready");

    const old = new InMemoryRelayRegistry();
    await old.register("relay-old", "owner-1", multiProviderCapabilities, () => undefined, 14, "desktop-old", 0, "pair-old");
    await expectFailure(old.requestAcpReadiness({
      relayId: "relay-old", userId: "owner-1", requestId: "old", registrationId: "opencode-acp",
    }), "ACP_RELAY_UNAVAILABLE");

    await expectFailure(registry.requestAcpReadiness({
      relayId: "relay-1", userId: "owner-1", requestId: "opencode-too-slow", registrationId: "opencode-acp", timeoutMs: 5_001,
    }), "ACP_REQUEST_INVALID");
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toMatchObject({ message });
}
