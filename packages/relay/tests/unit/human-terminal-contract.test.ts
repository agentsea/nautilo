import { expect, test } from "bun:test";
import { parseRelayHumanTerminalBinding, parseRelayHumanTerminalCapability, projectRelayCapabilitiesForProtocol } from "../../src/index";
const owner = { humanUserId: "human", agentId: "agent", roomId: "room", conversationId: "thread", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pair", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" };
const { conversationId: _conversation, ...selection } = owner;
const binding = { version: 1 as const, generation: "consent", invocationId: "call", owner };
const capability = { version: 1 as const, generation: "consent", owner: selection };
test("Human handoff wire contracts are closed and cannot carry PTY selectors", () => {
  expect(parseRelayHumanTerminalBinding(binding)).toEqual(binding);
  expect(parseRelayHumanTerminalCapability(capability)).toEqual(capability);
  for (const malformed of [{ ...binding, sessionId: "chosen" }, { ...binding, generation: [] }, { ...binding, owner: { ...owner, serverOrigin: "https://server.example/path" } }]) expect(parseRelayHumanTerminalBinding(malformed)).toBeNull();
  for (const malformed of [{ ...capability, owner }, { ...capability, version: 2 }, { ...capability, generation: " " }]) expect(parseRelayHumanTerminalCapability(malformed)).toBeNull();
});
test("older negotiated peers never advertise the new Human consent lane", () => {
  const caps = { profile: "desktop-agent" as const, canUseTerminal: true, canUseHumanTerminal: true, humanTerminal: capability as NonNullable<Parameters<typeof projectRelayCapabilitiesForProtocol>[0]["humanTerminal"]> };
  for (const version of [1, 20, 21, 22, 23]) {
    const projected = projectRelayCapabilitiesForProtocol(caps, version);
    expect(projected.canUseHumanTerminal).toBeUndefined(); expect(projected.humanTerminal).toBeUndefined(); expect(projected.canUseTerminal).toBeTrue();
  }
  expect(projectRelayCapabilitiesForProtocol(caps, 24).humanTerminal).toEqual(capability);
});
