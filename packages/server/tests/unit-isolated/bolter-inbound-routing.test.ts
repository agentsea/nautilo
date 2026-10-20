// Module mocks stay in this process through the server's isolated unit runner.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { BolterReceivedMessage } from "@nautilo/types";

const userId = "10000000-0000-4000-8000-000000000001";
const connectionId = "10000000-0000-4000-8000-000000000002";
const bindingId = "10000000-0000-4000-8000-000000000003";
const self = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const scope = { userId, relayId: "relay-fixture", relaySessionId: "session-fixture", desktopSessionId: "desktop-fixture",
  pairingGenerationRef: "pairing-fixture", selectedProtocolVersion: 30, capabilityRevision: 1 };
const connection = { id: connectionId, userId, relayId: scope.relayId, desktopSessionId: scope.desktopSessionId,
  pairingGenerationRef: scope.pairingGenerationRef, providerAgentId: "11111111", identityFingerprint: "a".repeat(64),
  generation: 1, revision: 0, enabled: true, revokedAt: null };
const resolveBinding = mock(async () => ({ id: bindingId, revision: 0 }));
const actualDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getSharedDirectAgentDb: () => ({}),
  getSharedDirectDb: () => ({}),
  getBolterConnectionWith: async () => connection,
  listBolterConnectionsWith: async () => [connection],
  listBolterBindingsWith: async () => [],
  resolveBolterBindingWith: resolveBinding,
}));
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({ ...actualTrust, assertExternalRoomTextMode: async () => {} }));
mock.module("../../src/realtime/ws-publisher", () => ({
  convergeHumanRoomCatalogs: async () => {}, publishBolterStateChanged: () => {},
}));

const { createBolterController } = await import("../../src/messaging/bolter-controller");
type RelayPort = Parameters<typeof createBolterController>[0]["relay"];
type BatchHandler = Parameters<RelayPort["onBolterBatch"]>[0];
let receiveBatch: BatchHandler | undefined;
const execution = { accept: mock(async (_input: unknown, _message: unknown) => ({ ok: true as const })) };
let controller: ReturnType<typeof createBolterController>;
const relay: RelayPort = {
  getBolterSession: (relayId, ownerId) => relayId === scope.relayId && ownerId === userId ? scope : null,
  listBolterSessions: () => [scope],
  onBolterObservation: () => () => {},
  onBolterContext: () => () => {},
  onBolterBatch: listener => { receiveBatch = listener; return () => { receiveBatch = undefined; }; },
  async requestBolterCommand(input) {
    if (input.command.action === "list_conversations") return { kind: "conversations", conversations: [] };
    return { kind: "observation", observation: { runtime: "qualified", authentication: "confirmed", receiver: "listening",
      identity: { providerAgentId: connection.providerAgentId, identityFingerprint: connection.identityFingerprint, label: "Fixture helper" } } };
  },
};
function message(messageId: string, content: string, extra: Partial<BolterReceivedMessage> = {}): BolterReceivedMessage {
  return { type: "message", messageId, chatId: "chat-fixture", threadRootId: null, senderId: "human-fixture",
    senderType: "user", content, addressed: false, truncated: false, redelivered: false,
    createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}
async function deliver(messages: BolterReceivedMessage[]) {
  if (!receiveBatch) throw new Error("Fixture batch handler missing");
  return receiveBatch({ userId, message: { type: "relay:bolter-batch", version: 30, scope,
    connectionId, generation: 1, batchId: "10000000-0000-4000-8000-000000000004", messages } });
}
beforeEach(async () => {
  resolveBinding.mockClear();
  execution.accept.mockClear();
  controller = createBolterController({ relay, execution: execution as never });
  expect(await controller.check(userId, connectionId)).toMatchObject({ status: "connected" });
});
afterEach(async () => { await controller.close(); });

test("requests for another agent are acknowledged without dispatching or blocking the next Human message", async () => {
  for (const addressed of [false, true]) {
    expect(await deliver([message("other-request", `[@Builder](#mention-aid:${other}) Please update the page.`, { addressed })]))
      .toBe("accepted");
  }
  expect(resolveBinding).not.toHaveBeenCalled();
  expect(execution.accept).not.toHaveBeenCalled();
  const ordinary = message("ordinary-request", "Can you help me with the meeting notes?");
  expect(await deliver([ordinary])).toBe("accepted");
  expect(execution.accept).toHaveBeenCalledTimes(1);
  expect(execution.accept.mock.calls[0]?.[1]).toEqual(ordinary);
});

test("a mixed batch dispatches direct and shared mentions, and skips unrelated agent traffic", async () => {
  const unrelated = message("unrelated", `[@Builder](#mention-aid:${other}) Please review this.`);
  const direct = message("direct", `[@Helper](#mention-aid:${self}) What do you think?`);
  const shared = message("shared", `[@Builder](#mention-aid:${other}) and [@Helper](#mention-aid:${self}) Please review this.`);
  const unaddressedAgent = message("agent", "Here is my progress.", { senderType: "anima", senderId: "agent-fixture" });
  expect(await deliver([unrelated, direct, unaddressedAgent, shared])).toBe("accepted");
  expect(execution.accept).toHaveBeenCalledTimes(2);
  expect(execution.accept.mock.calls.map(call => call[1])).toEqual([direct, shared]);
});
