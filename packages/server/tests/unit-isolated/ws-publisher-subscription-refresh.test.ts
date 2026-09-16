/**
 * M075 / D246 — `refreshRoomSubscriptionsForUser` must reload room IDs without
 * paying the compact roster query cost (internal subscription refresh only).
 */
import { describe, expect, mock, test } from "bun:test";
import type { WebSocket as WsWebSocket } from "ws";

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ROOM_B = "22222222-2222-4222-8222-222222222222";
const NAMESPACE_B = "33333333-3333-4333-8333-333333333333";

const listRoomsSpy = mock(async (
  _actorId: string,
  options?: { includeRoster?: boolean; includeSubthreads?: boolean },
) => {
  if (options?.includeRoster === false && options.includeSubthreads === true) {
    return [{ id: ROOM_A }, { id: ROOM_B }];
  }
  return [{ id: ROOM_A, roster: [] }];
});

mock.module("@nautilo/trust", () => ({
  listRoomsForActor: listRoomsSpy,
  getHumanSenderUserIdForMessageBroadcast: async () => null,
  getChangedNotificationState: async () => [],
  markDelivered: async () => {},
}));

const {
  addClient,
  broadcast,
  convergeHumanRoomCatalogs,
  publishRoomMembersChanged,
  refreshRoomSubscriptionsForUser,
} =
  await import("../../src/realtime/ws-publisher");

interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  send(payload: string): void;
  on(_event: "close", _handler: () => void): void;
  [k: string]: unknown;
}

function makeClient(): MockWs {
  return {
    readyState: 1,
    sent: [],
    OPEN: 1,
    send(payload: string) {
      this.sent.push(payload);
    },
    on() {
      /* no-op */
    },
  };
}

async function waitForSent(client: MockWs): Promise<void> {
  const started = Date.now();
  while (client.sent.length === 0) {
    if (Date.now() - started > 500) {
      throw new Error("timed out waiting for ws send");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function eventType(payload: string): string | undefined {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const type = (parsed as Record<string, unknown>)["type"];
  return typeof type === "string" ? type : undefined;
}

describe("refreshRoomSubscriptionsForUser (M075 skip-roster reload)", () => {
  test("requests room IDs with includeRoster: false and updates every tab", async () => {
    listRoomsSpy.mockClear();

    const tabA = makeClient();
    const tabB = makeClient();
    const otherUser = makeClient();

    addClient(tabA as unknown as WsWebSocket, {
      userId: "user-refresh",
      actorId: "actor-refresh",
      roomIds: new Set(["00000000-0000-4000-8000-000000000001"]),
    });
    addClient(tabB as unknown as WsWebSocket, {
      userId: "user-refresh",
      actorId: "actor-refresh",
      roomIds: new Set(["00000000-0000-4000-8000-000000000001"]),
    });
    addClient(otherUser as unknown as WsWebSocket, {
      userId: "other-user",
      actorId: "other-actor",
      roomIds: new Set(["00000000-0000-4000-8000-000000000001"]),
    });

    await refreshRoomSubscriptionsForUser("user-refresh", "actor-refresh");

    expect(listRoomsSpy).toHaveBeenCalledTimes(1);
    expect(listRoomsSpy).toHaveBeenCalledWith("actor-refresh", {
      includeRoster: false,
      includeSubthreads: true,
    });

    publishRoomMembersChanged(ROOM_B, {
      kind: "member_added",
      actorId: "new-member-actor",
      actorKind: "user",
      displayName: "New Member",
    }, NAMESPACE_B);
    await waitForSent(tabA);

    expect(tabA.sent.length).toBe(1);
    expect(tabB.sent.length).toBe(1);
    expect(otherUser.sent.length).toBe(0);
    expect(JSON.parse(tabA.sent[0]!)).toMatchObject({
      type: "room_members_changed",
      roomId: ROOM_B,
      recipientSyncNamespaceId: NAMESPACE_B,
    });
  });

  test("created-room convergence refreshes the recipient before catalog and room events", async () => {
    listRoomsSpy.mockClear();

    const peer = makeClient();
    addClient(peer as unknown as WsWebSocket, {
      userId: "new-room-peer",
      actorId: "new-room-peer-actor",
      roomIds: new Set([ROOM_A]),
    });

    await convergeHumanRoomCatalogs([
      { userId: "new-room-peer", actorId: "new-room-peer-actor" },
    ]);
    broadcast({
      type: "message.new",
      laneKey: `room:${ROOM_B}`,
      messageId: "99",
      role: "ai",
      content: "A live peer message",
    });
    await waitForSent(peer);

    expect(listRoomsSpy).toHaveBeenCalledWith("new-room-peer-actor", {
      includeRoster: false,
      includeSubthreads: true,
    });
    expect(peer.sent.map(eventType)).toEqual([
      "room.catalog.changed",
      "message.new",
    ]);
  });
});
