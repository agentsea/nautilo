/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import { getRoomModelSelection, setRoomModelSelection } from "./room-model-selection";

test("returns no override for an unselected room", () => {
  expect(getRoomModelSelection("server-absent", "room-absent")).toBeNull();
});

test("keeps selections isolated by server and room", () => {
  setRoomModelSelection("server-a", "room-1", "model-a1");
  setRoomModelSelection("server-a", "room-2", "model-a2");
  setRoomModelSelection("server-b", "room-1", "model-b1");

  expect(getRoomModelSelection("server-a", "room-1")).toBe("model-a1");
  expect(getRoomModelSelection("server-a", "room-2")).toBe("model-a2");
  expect(getRoomModelSelection("server-b", "room-1")).toBe("model-b1");
});

test("clears a room override back to the inherited Agent/server default", () => {
  setRoomModelSelection("server-clear", "room-clear", "model-override");
  setRoomModelSelection("server-clear", "room-clear", null);

  expect(getRoomModelSelection("server-clear", "room-clear")).toBeNull();
});
