import { expect, test } from "bun:test";
import { handleRelayBolterMessage, parseRelayEndpointClientMessage } from "../../src/realtime/relay-endpoint";

const message = { type: "relay:bolter-result" as const, version: 30 as const,
  correlationId: "719f18c6-a3a9-4b8e-994a-9fa36136552e",
  scope: { relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pair-1", selectedProtocolVersion: 30, capabilityRevision: 0 },
  result: { kind: "unavailable" as const, reason: "qualification_required" as const } };

test("Bolter endpoint rejects extra authority and server-command direction", () => {
  expect(parseRelayEndpointClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
  for (const value of [{ ...message, userId: "foreign" }, { ...message, type: "relay:bolter-command" },
    { ...message, scope: { ...message.scope, namespaceId: "foreign" } }]) {
    expect(parseRelayEndpointClientMessage(JSON.stringify(value))).toMatchObject({ ok: false, error: "BOLTER_FRAME_INVALID" });
  }
});
test("only the current authenticated socket reaches Bolter admission", async () => {
  let accepted = 0;
  const registry = { acceptBolterMessage: async () => { accepted++; return { ok: true as const }; } };
  const input = { registeredRelayId: "relay-1", registeredUserId: "human-1", registeredProtocolVersion: 30, currentSocket: true, message, registry };
  expect(await handleRelayBolterMessage(input)).toEqual({ ok: true });
  for (const changed of [{ currentSocket: false }, { registeredRelayId: null }, { registeredUserId: null },
    { registeredRelayId: "foreign" }, { registeredProtocolVersion: 29 }]) {
    expect(await handleRelayBolterMessage({ ...input, ...changed })).toEqual({ ok: false, error: "BOLTER_UNAVAILABLE" });
  }
  expect(accepted).toBe(1);
});
