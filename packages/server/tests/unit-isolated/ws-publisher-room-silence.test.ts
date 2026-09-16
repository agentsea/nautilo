/**
 * D279 Phase 3.6 — `publishRoomSilenceChanged` fans out to room subscribers.
 */
import { describe, expect, test } from "bun:test";
import type { WebSocket as WsWebSocket } from "ws";
import {
  addClient,
  publishRoomConductorModeChanged,
  publishRoomSilenceChanged,
  publishProtectedMessageUpdated,
} from "../../src/realtime/ws-publisher";

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ROOM_B = "22222222-2222-4222-8222-222222222222";

interface MockWs {
  readyState: number;
  sent: string[];
  OPEN: number;
  send(payload: string): void;
  on(_event: "close", _handler: () => void): void;
  [k: string]: unknown;
}

function makeClient(open = true): MockWs {
  return {
    readyState: open ? 1 : 3,
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

describe("publishRoomSilenceChanged (D279 3.6 room fan-out)", () => {
  test("publishes a Full edit only as a protected Room-scoped frame", async () => {
    const member = makeClient();
    const otherRoom = makeClient();
    addClient(member as unknown as WsWebSocket, {
      userId: "user-A", actorId: "act-A", roomIds: new Set([ROOM_A]),
    });
    addClient(otherRoom as unknown as WsWebSocket, {
      userId: "user-B", actorId: "act-B", roomIds: new Set([ROOM_B]),
    });
    publishProtectedMessageUpdated({
      roomId: ROOM_A,
      message: {
        dtoVersion: 2,
        projection: {
          messageId: "42",
          logicalMessageKey: "human:42",
          sessionId: "33333333-3333-4333-8333-333333333333",
          roomId: ROOM_A,
          namespaceId: "44444444-4444-4444-8444-444444444444",
          role: "user",
          createdAt: "2026-08-03T09:10:11.000Z",
          editedAt: "2026-08-03T09:11:12.000Z",
          editRevision: 1,
        },
        protectedPayload: {
          status: "encrypted",
          cryptoObjectId: "message:v2:edit-42",
          payloadVersion: 2,
          keyClass: "human",
          encryptedPayloadBytesBase64url: "AA",
          accessManifestBytesBase64url: "AQ",
          namespaceEnvelopeBytesBase64url: "Ag",
        },
      },
    });
    await waitForSent(member);
    expect(otherRoom.sent).toHaveLength(0);
    const frame = JSON.parse(member.sent[0]!) as Record<string, unknown>;
    expect(frame).toMatchObject({
      wireVersion: 2,
      type: "message.updated",
      protection: "protected",
      laneKey: `room:${ROOM_A}`,
      logicalMessageKey: "human:42",
      editRevision: 1,
    });
    expect(JSON.stringify(frame)).not.toContain("content");
  });

  test("delivers to every subscriber of the room, not other rooms", async () => {
    const memberA = makeClient();
    const memberB = makeClient();
    const otherRoom = makeClient();

    addClient(memberA as unknown as WsWebSocket, {
      userId: "user-A",
      actorId: "act-A",
      roomIds: new Set([ROOM_A]),
    });
    addClient(memberB as unknown as WsWebSocket, {
      userId: "user-B",
      actorId: "act-B",
      roomIds: new Set([ROOM_A]),
    });
    addClient(otherRoom as unknown as WsWebSocket, {
      userId: "user-C",
      actorId: "act-C",
      roomIds: new Set([ROOM_B]),
    });

    const silence = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "deaf" as const,
      botActorId: null,
      botDisplayName: null,
      setByDisplayName: "Room Admin",
      expiresAt: "2026-06-09T12:30:00.000Z",
    };
    publishRoomSilenceChanged(ROOM_A, silence);
    await waitForSent(memberA);

    expect(memberA.sent).toHaveLength(1);
    expect(memberB.sent).toHaveLength(1);
    expect(otherRoom.sent).toHaveLength(0);

    const frame = JSON.parse(memberA.sent[0]!) as Record<string, unknown>;
    expect(frame).toEqual({
      type: "room.silence.changed",
      roomId: ROOM_A,
      laneKey: `room:${ROOM_A}`,
      silence,
    });
  });

  test("conductor mode change delivers to room subscribers", async () => {
    const memberA = makeClient();
    const otherRoom = makeClient();

    addClient(memberA as unknown as WsWebSocket, {
      userId: "user-mode-A",
      actorId: "act-mode-A",
      roomIds: new Set([ROOM_A]),
    });
    addClient(otherRoom as unknown as WsWebSocket, {
      userId: "user-mode-B",
      actorId: "act-mode-B",
      roomIds: new Set([ROOM_B]),
    });

    publishRoomConductorModeChanged(ROOM_A, "standard");
    await waitForSent(memberA);

    expect(memberA.sent).toHaveLength(1);
    expect(otherRoom.sent).toHaveLength(0);
    expect(JSON.parse(memberA.sent[0]!) as Record<string, unknown>).toEqual({
      type: "room.conductor_mode.changed",
      roomId: ROOM_A,
      laneKey: `room:${ROOM_A}`,
      conductorMode: "standard",
    });
  });
});
