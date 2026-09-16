import { describe, expect, test } from "bun:test";

import {
  publishRoomProjection,
  subscribeRoomProjection,
  type RoomProjectionChange,
  type RoomProjectionScope,
} from "./chat-management-projection";

const serverAViewerA: RoomProjectionScope = { serverId: "server-a", viewerActorId: "viewer-a" };
const serverBViewerA: RoomProjectionScope = { serverId: "server-b", viewerActorId: "viewer-a" };
const serverAViewerB: RoomProjectionScope = { serverId: "server-a", viewerActorId: "viewer-b" };
const archive: RoomProjectionChange = { kind: "archived", roomId: "room-1", archived: true };

describe("D529 Room projection scope", () => {
  test("delivers only to the exact server and viewer identity", () => {
    const exact: RoomProjectionChange[] = [];
    const otherServer: RoomProjectionChange[] = [];
    const otherViewer: RoomProjectionChange[] = [];
    const unsubscribe = [
      subscribeRoomProjection(serverAViewerA, (change) => exact.push(change)),
      subscribeRoomProjection(serverBViewerA, (change) => otherServer.push(change)),
      subscribeRoomProjection(serverAViewerB, (change) => otherViewer.push(change)),
    ];

    publishRoomProjection(serverAViewerA, archive);

    expect(exact).toEqual([archive]);
    expect(otherServer).toEqual([]);
    expect(otherViewer).toEqual([]);
    unsubscribe.forEach((dispose) => dispose());
  });

  test("stops delivery after the exact subscriber is removed", () => {
    const received: RoomProjectionChange[] = [];
    const unsubscribe = subscribeRoomProjection(serverAViewerA, (change) => received.push(change));
    unsubscribe();

    publishRoomProjection(serverAViewerA, { kind: "left", roomId: "room-1" });

    expect(received).toEqual([]);
  });
});
