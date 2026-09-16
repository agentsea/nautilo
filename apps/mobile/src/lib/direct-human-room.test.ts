/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import type { RoomMemberDto } from "@nautilo/types";

import { isDirectAgentRoom, isDirectHumanRoom } from "./direct-human-room";

function member(kind: RoomMemberDto["kind"], actorId = `${kind}-actor`): RoomMemberDto {
  return {
    actorId,
    kind,
    displayName: kind === "user" ? "Human" : "Agent",
    roomRole: "member",
  };
}

test("matches exactly two Human members", () => {
  expect(isDirectHumanRoom([member("user", "human-a"), member("user", "human-b")])).toBe(true);
});

test("does not match any roster containing an Agent", () => {
  expect(isDirectHumanRoom([member("user"), member("agent")])).toBe(false);
  expect(isDirectHumanRoom([member("agent"), member("agent")])).toBe(false);
});

test("does not change single-Human or Human-group rooms", () => {
  expect(isDirectHumanRoom([member("user")])).toBe(false);
  expect(
    isDirectHumanRoom([
      member("user", "human-a"),
      member("user", "human-b"),
      member("user", "human-c"),
    ]),
  ).toBe(false);
});

test("requires two distinct Human actors", () => {
  const duplicate = member("user");
  expect(isDirectHumanRoom([duplicate, { ...duplicate }])).toBe(false);
});

test("matches only an exact Human-Agent pair", () => {
  expect(isDirectAgentRoom([member("user"), member("agent")])).toBe(true);
  expect(isDirectAgentRoom([member("user", "one"), member("user", "two")])).toBe(false);
  expect(isDirectAgentRoom([member("agent", "one"), member("agent", "two")])).toBe(false);
  expect(isDirectAgentRoom([
    member("user"),
    member("agent", "agent-a"),
    member("agent", "agent-b"),
  ])).toBe(false);
});
