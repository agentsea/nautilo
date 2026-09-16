import { describe, expect, test } from "bun:test";
import type { WebSocket } from "ws";
import {
  addClient,
  publishRemoteHostPresenceFrame,
} from "../../src/realtime/ws-publisher";
import type { RemoteHostConnectedEvent } from "@nautilo/types";

function socket() {
  const sent: string[] = [];
  const closeHandlers: Array<() => void> = [];
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send: (value: string) => sent.push(value),
    on: (event: string, handler: () => void) => {
      if (event === "close") closeHandlers.push(handler);
    },
    close: () => closeHandlers.forEach((handler) => handler()),
  };
}

describe("D458 explicit remote-host viewer publication", () => {
  test("reaches every owner socket and zero foreign sockets with no internal identifiers", () => {
    const ownerA = socket();
    const ownerB = socket();
    const foreign = socket();
    addClient(ownerA as unknown as WebSocket, {
      userId: "owner",
      actorId: "owner-actor",
      roomIds: new Set(),
    });
    addClient(ownerB as unknown as WebSocket, {
      userId: "owner",
      actorId: "owner-actor",
      roomIds: new Set(),
    });
    addClient(foreign as unknown as WebSocket, {
      userId: "foreign",
      actorId: "foreign-actor",
      roomIds: new Set(),
    });
    const event: RemoteHostConnectedEvent = {
      type: "remote.host.connected",
      eventId: "stream-a:1",
      streamId: "stream-a",
      sequence: 1,
      snapshotRevision: 1,
      remoteHostId: "445e9ba2-b7f9-4771-8ebc-ebdd41918a7b",
      host: {
        remoteHostId: "445e9ba2-b7f9-4771-8ebc-ebdd41918a7b",
        label: "Writer's Mac",
        connected: true,
        readiness: "compatible_online",
        lastSeenAt: "2026-07-27T12:00:00.000Z",
      },
    };

    publishRemoteHostPresenceFrame("owner", event);
    expect(ownerA.sent).toEqual([JSON.stringify(event)]);
    expect(ownerB.sent).toEqual([JSON.stringify(event)]);
    expect(foreign.sent).toEqual([]);
    for (const payload of ownerA.sent) {
      expect(payload).not.toContain("userId");
      expect(payload).not.toContain("relayId");
      expect(payload).not.toContain("pairingGeneration");
      expect(payload).not.toContain("desktopSessionId");
    }
    ownerA.close();
    ownerB.close();
    foreign.close();
  });
});
