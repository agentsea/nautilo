/**
 * Isolated because Bun's mock.module replacements are process-global and sticky.
 * The server unit runner executes every file in this directory in its own process.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const userId = "11111111-1111-4111-8111-111111111111";
const humanActorId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const genieActorId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const bindingId = "66666666-6666-4666-8666-666666666666";
const namespaceId = "77777777-7777-4777-8777-777777777777";
const scope = {
  relayId: "relay-fixture", userId, relaySessionId: "relay-session-fixture",
  desktopSessionId: "desktop-session-fixture", pairingGenerationRef: "pairing-generation-fixture",
  selectedProtocolVersion: 30, capabilityRevision: 1,
};
const connection = {
  id: connectionId, userId, relayId: scope.relayId, desktopSessionId: scope.desktopSessionId,
  pairingGenerationRef: scope.pairingGenerationRef, homeHandle: "home-fixture", origin: "https://bolter.chat",
  providerAgentId: "provider-agent-fixture", identityFingerprint: "a".repeat(64), generation: 1, revision: 3,
  enabled: true, revokedAt: null, createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const observation = {
  runtime: "qualified" as const, authentication: "confirmed" as const,
  identity: { providerAgentId: connection.providerAgentId, identityFingerprint: connection.identityFingerprint, label: "Fixture identity" },
  receiver: "stopped" as const,
};

const order: string[] = [];
const roomInputs: unknown[] = [];
const bindingContexts: unknown[] = [];
const invocationChecks: unknown[] = [];
const publishedUsers: string[] = [];
let binding: Record<string, unknown> | null = null;
let releaseConvergence: (() => void) | undefined;
let convergenceEntered: Promise<void> = Promise.resolve();
let markConvergenceEntered: (() => void) | undefined;

const actualDb = await import("@nautilo/db");
const productDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ label: "Fixture external Room" }] }) }) }),
};
mock.module("@nautilo/db", () => ({
  ...actualDb,
  getSharedDirectAgentDb: () => ({ kind: "agent-db-fixture" }),
  getSharedDirectDb: () => productDb,
  getBolterConnectionWith: async (_db: unknown, context: unknown, id: string) => {
    expect(context).toEqual({ userId });
    return id === connectionId ? connection : null;
  },
  listBolterConnectionsWith: async () => [connection],
  listBolterBindingsWith: async () => [],
  listBolterOutboxWith: async () => [],
  getBolterDeliveryCountsWith: async () => ({ pending: 0, uncertain: 0 }),
  createFreshBolterBindingWith: async (_db: unknown, context: unknown,
    createRoom: (tx: unknown, row: typeof connection) => Promise<Record<string, unknown>>) => {
    order.push("binding-transaction:start");
    bindingContexts.push(context);
    const input = await createRoom({ kind: "transaction-fixture" }, connection);
    binding = { id: bindingId, userId, connectionId, origin: connection.origin,
      providerAgentId: connection.providerAgentId, revision: 0, state: "active", modelSponsorshipAcceptedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(), ...input };
    order.push("binding-transaction:committed");
    return binding;
  },
}));

const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  assertExternalRoomTextMode: async () => {},
  assertCanInvokeAgent: async (input: unknown) => { invocationChecks.push(input); },
  findActorByOwnerId: async (ownerId: string) => ownerId === userId ? { id: humanActorId } : null,
  findAgentActorForAgent: async (id: string) => id === agentId ? { id: genieActorId } : null,
  insertPrivateRoomBundleTx: async (_tx: unknown, input: unknown) => {
    order.push("room-bundle:inserted");
    roomInputs.push(input);
    return { namespaceId };
  },
}));

const actualRuntime = await import("@nautilo/runtime");
mock.module("@nautilo/runtime", () => ({
  ...actualRuntime,
  eventBus: { emit: mock(() => {}) },
}));

const convergeHumanRoomCatalogs = mock(async (targets: readonly { userId: string; actorId: string }[]) => {
  order.push("catalog-convergence:start");
  markConvergenceEntered?.();
  await new Promise<void>(resolve => { releaseConvergence = resolve; });
  order.push("catalog-convergence:finished");
  expect(targets).toEqual([{ userId, actorId: humanActorId }]);
});
const publishBolterStateChanged = mock((targetUserId: string) => {
  order.push("bolter-state:published");
  publishedUsers.push(targetUserId);
});
mock.module("../../src/realtime/ws-publisher", () => ({ convergeHumanRoomCatalogs, publishBolterStateChanged }));

const { createBolterController } = await import("../../src/messaging/bolter-controller");
type RelayPort = Parameters<typeof createBolterController>[0]["relay"];
let receiverStarts = 0;
let requestedActions: string[] = [];
const relay: RelayPort = {
  getBolterSession: (relayId, targetUserId) => relayId === scope.relayId && targetUserId === userId ? scope : null,
  listBolterSessions: targetUserId => targetUserId === userId ? [scope] : [],
  onBolterObservation: () => () => undefined,
  onBolterBatch: () => () => undefined,
  onBolterContext: () => () => undefined,
  async requestBolterCommand(input) {
    requestedActions.push(input.command.action);
    if (input.command.action === "list_conversations") return { kind: "conversations", conversations: [
      { label: "Fixture provider conversation", chatId: "provider-chat-fixture", threadRootId: null },
    ] };
    if (input.command.action === "start_receiver") {
      receiverStarts++;
      order.push("receiver:start");
      return { kind: "observation", observation: { ...observation, receiver: "listening" as const } };
    }
    return { kind: "observation", observation };
  },
};
const execution = { accept: mock(async () => ({ ok: true })) };
const controller = createBolterController({ relay, execution: execution as never });

beforeEach(() => {
  order.length = 0;
  roomInputs.length = 0;
  bindingContexts.length = 0;
  invocationChecks.length = 0;
  publishedUsers.length = 0;
  binding = null;
  receiverStarts = 0;
  requestedActions = [];
  releaseConvergence = undefined;
  convergenceEntered = new Promise<void>(resolve => { markConvergenceEntered = resolve; });
  convergeHumanRoomCatalogs.mockClear();
  publishBolterStateChanged.mockClear();
  execution.accept.mockClear();
});

afterAll(async () => { releaseConvergence?.(); await controller.close(); });

test("Bolter Room creation converges the Human's live catalogue before notifications or receiver dispatch", async () => {
  expect(await controller.check(userId, connectionId)).toMatchObject({ status: "connected", canCreateRoom: true });
  const conversations = await controller.conversations(userId, connectionId);
  expect(conversations).toMatchObject({ status: "available", conversations: [
    { label: "Fixture provider conversation", chatId: "provider-chat-fixture", threadRootId: null },
  ] });
  const choice = conversations.conversations[0];
  if (!choice) throw new Error("Fixture conversation choice missing");

  order.length = 0;
  publishedUsers.length = 0;
  requestedActions = [];
  publishBolterStateChanged.mockClear();
  const creating = controller.createRoom(userId, connectionId, {
    choiceId: choice.id, agentId, name: "Fixture external Room", modelSponsorshipAccepted: true,
  });
  await convergenceEntered;

  expect(order).toEqual([
    "binding-transaction:start", "room-bundle:inserted", "binding-transaction:committed", "catalog-convergence:start",
  ]);
  expect(publishBolterStateChanged).not.toHaveBeenCalled();
  expect(receiverStarts).toBe(0);
  expect(requestedActions).toEqual([]);
  expect(execution.accept).not.toHaveBeenCalled();

  releaseConvergence?.();
  const created = await creating;
  expect(created).toMatchObject({ roomId: binding?.["roomId"], link: {
    id: bindingId, roomName: "Fixture external Room", agentId, connectionId,
    chatId: "provider-chat-fixture", threadRootId: null, receiver: "listening",
  } });
  expect(order.slice(0, 5)).toEqual([
    "binding-transaction:start", "room-bundle:inserted", "binding-transaction:committed",
    "catalog-convergence:start", "catalog-convergence:finished",
  ]);
  const convergenceFinished = order.indexOf("catalog-convergence:finished");
  const firstStatePublication = order.indexOf("bolter-state:published");
  const receiverStart = order.indexOf("receiver:start");
  expect(firstStatePublication).toBeGreaterThan(convergenceFinished);
  expect(receiverStart).toBeGreaterThan(firstStatePublication);
  expect(convergeHumanRoomCatalogs).toHaveBeenCalledWith([{ userId, actorId: humanActorId }]);
  expect(publishedUsers.length).toBeGreaterThan(0);
  expect(publishedUsers.every(id => id === userId)).toBe(true);
  expect(requestedActions).toEqual(["start_receiver"]);
  expect(receiverStarts).toBe(1);
  expect(execution.accept).not.toHaveBeenCalled();
  expect(invocationChecks).toEqual([{ humanUserId: userId, origin: "room_message", agentId }]);
  expect(bindingContexts).toEqual([{
    userId, connectionId, connectionGeneration: connection.generation, relayId: scope.relayId,
    desktopSessionId: scope.desktopSessionId, pairingGenerationRef: scope.pairingGenerationRef,
  }]);
  expect(roomInputs).toEqual([expect.objectContaining({
    ownerUserId: userId, label: "Fixture external Room", humanActorIds: [humanActorId], createdByActorId: humanActorId,
    memberRows: [{ actorId: humanActorId, roomRole: "admin" },
      { actorId: genieActorId, roomRole: "member", agentResponseMode: "active" }],
    roomKind: "private", roomType: "private", discoverable: false, externalContext: true,
  })]);
});
