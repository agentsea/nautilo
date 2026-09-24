import { expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import { createRoomChangeSource } from "../../src/companion/room-changes";

test("secondary Room views receive only their registered Room and unsubscribe independently", () => {
  const source = createRoomChangeSource();
  const a: ServerEvent[] = []; const b: ServerEvent[] = [];
  const off = source.subscribeToRoom("a", event => a.push(event));
  source.subscribeToRoom("b", event => b.push(event));
  const event: ServerEvent = { type: "message.tokens", laneKey: "room:a", content: "First", done: false };
  source.publish("a");
  expect(a).toHaveLength(0);
  source.publishAdmittedEvent("a", event);
  expect(a).toEqual([event]); expect(b).toHaveLength(0);
  off(); expect(source.hasRoom("a")).toBe(false); expect(source.hasRoom("b")).toBe(true);
  source.subscribeToRoom("a", event => a.push(event));
  off(); expect(source.hasRoom("a")).toBe(true);
});
