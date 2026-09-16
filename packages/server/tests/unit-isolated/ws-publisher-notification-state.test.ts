import { describe, expect, mock, test } from "bun:test";
import type { WebSocket as WsWebSocket } from "ws";
import {
  addClient,
  recomputeAndPublishNotificationState,
} from "../../src/realtime/ws-publisher";

const ROOM = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const getChangedNotificationState = mock(async () => [
  {
    userId: USER,
    roomId: ROOM,
    topLevelRoomId: ROOM,
    roomOwnUnreadCount: 3,
    roomOwnImportantUnreadCount: 2,
    topLevelUnreadCount: 5,
    topLevelImportantUnreadCount: 4,
  },
]);

interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  send(payload: string): void;
  on(_event: "close", _handler: () => void): void;
  [key: string]: unknown;
}

function makeClient(): MockWs {
  return {
    readyState: 1,
    sent: [],
    OPEN: 1,
    send(payload: string) {
      this.sent.push(payload);
    },
    on() {},
  };
}

describe("M236 notification state publication", () => {
  test("publishes the canonical viewer-scoped notification event", async () => {
    const recipient = makeClient();
    const other = makeClient();
    addClient(recipient as unknown as WsWebSocket, {
      userId: USER,
      actorId: "actor-user",
      roomIds: new Set(),
    });
    addClient(other as unknown as WsWebSocket, {
      userId: "other-user",
      actorId: "actor-other",
      roomIds: new Set([ROOM]),
    });

    await recomputeAndPublishNotificationState({
      roomId: ROOM,
      recipientUserIds: [USER, "another-recipient"],
    }, {
      getChangedState: getChangedNotificationState,
    });

    expect(getChangedNotificationState).toHaveBeenCalledTimes(1);
    expect(getChangedNotificationState).toHaveBeenCalledWith(ROOM, [
      USER,
      "another-recipient",
    ]);
    expect(
      recipient.sent.map((payload): unknown => JSON.parse(payload) as unknown),
    ).toEqual([{
      type: "room.notification.changed",
      userId: USER,
      roomId: ROOM,
      topLevelRoomId: ROOM,
      roomOwnUnreadCount: 3,
      roomOwnImportantUnreadCount: 2,
      topLevelUnreadCount: 5,
      topLevelImportantUnreadCount: 4,
    }]);
    expect(other.sent).toHaveLength(0);
  });
});
