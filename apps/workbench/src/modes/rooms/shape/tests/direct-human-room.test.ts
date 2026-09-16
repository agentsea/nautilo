import { describe, expect, test } from "bun:test";
import type { RoomMemberDto } from "@nautilo/types";
import { resolveDirectHumanRoom } from "../direct-human-room";

const human = (actorId: string, userId: string, displayName = actorId): RoomMemberDto => ({
  actorId,
  userId,
  kind: "user",
  displayName,
  roomRole: "member",
});

const agent = (actorId: string): RoomMemberDto => ({
  actorId,
  agentId: actorId,
  kind: "agent",
  displayName: actorId,
  roomRole: "member",
});

describe("resolveDirectHumanRoom", () => {
  test("recognizes exactly two Humans regardless of any room-kind metadata", () => {
    const state = resolveDirectHumanRoom({
      // The predicate intentionally receives only the roster: group-kind
      // metadata must not turn this direct conversation into conductor UI.
      members: [human("alex-actor", "alex-user", "Alex"), human("kevin-actor", "kevin-user", "Kevin")],
      viewerActorId: "alex-actor",
      viewerUserId: "alex-user",
    });

    expect(state.isDirectHumanRoom).toBe(true);
    expect(state.peer?.displayName).toBe("Kevin");
  });

  test("can resolve the viewer through user identity when actor identity is unavailable", () => {
    const state = resolveDirectHumanRoom({
      members: [human("alex-actor", "alex-user", "Alex"), human("kevin-actor", "kevin-user", "Kevin")],
      viewerActorId: null,
      viewerUserId: "kevin-user",
    });

    expect(state).toMatchObject({
      isDirectHumanRoom: true,
      peer: { displayName: "Alex" },
    });
  });

  test.each([
    ["three humans", [human("alex", "alex"), human("kevin", "kevin"), human("taylor", "taylor")]],
    ["a human and an Agent", [human("alex", "alex"), agent("genie")]],
    ["two humans and an Agent", [human("alex", "alex"), human("kevin", "kevin"), agent("genie")]],
    ["an empty roster", []],
  ])("does not widen direct-human chrome for %s", (_label, members) => {
    expect(
      resolveDirectHumanRoom({
        members,
        viewerActorId: "alex",
        viewerUserId: "alex",
      }),
    ).toEqual({ isDirectHumanRoom: false, peer: null });
  });

  test("rejects an incomplete roster that does not contain the viewer", () => {
    expect(
      resolveDirectHumanRoom({
        members: [human("kevin", "kevin"), human("taylor", "taylor")],
        viewerActorId: "alex",
        viewerUserId: "alex",
      }),
    ).toEqual({ isDirectHumanRoom: false, peer: null });
  });
});
