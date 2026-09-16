import { describe, expect, test } from "bun:test";
import type { RoomMemberDto } from "@nautilo/types";
import { resolveRoomModelAgentTarget } from "./room-model-agent-target";

const agent = (actorId: string, agentId: string): RoomMemberDto => ({
  actorId,
  agentId,
  kind: "agent",
  displayName: agentId,
  roomRole: "member",
});

const user = (actorId: string): RoomMemberDto => ({
  actorId,
  kind: "user",
  displayName: actorId,
  roomRole: "member",
});

describe("resolveRoomModelAgentTarget", () => {
  const members = [user("viewer"), agent("mine", "agent-mine"), agent("theirs", "agent-theirs")];
  const ownedAgentIds = new Set(["agent-mine"]);

  test.each([
    ["no focus", { kind: "none" as const }],
    ["another Agent focused", { kind: "single" as const, botActorId: "theirs" }],
    ["focus ambiguous", { kind: "ambiguous" as const, botActorIds: ["mine", "theirs"] }],
  ])("uses the sole owned Room Agent with %s", (_label, ring) => {
    expect(resolveRoomModelAgentTarget({ members, ownedAgentIds, ring })).toBe("agent-mine");
  });

  test("uses a focused owned Agent only when several owned Room Agents need disambiguation", () => {
    const twoOwned = [...members, agent("mine-too", "agent-mine-too")];
    const owners = new Set(["agent-mine", "agent-mine-too"]);

    expect(
      resolveRoomModelAgentTarget({
        members: twoOwned,
        ownedAgentIds: owners,
        ring: { kind: "single", botActorId: "mine-too" },
      }),
    ).toBe("agent-mine-too");
    expect(
      resolveRoomModelAgentTarget({
        members: twoOwned,
        ownedAgentIds: owners,
        ring: { kind: "none" },
      }),
    ).toBeNull();
    expect(
      resolveRoomModelAgentTarget({
        members: twoOwned,
        ownedAgentIds: owners,
        ring: { kind: "single", botActorId: "theirs" },
      }),
    ).toBeNull();
    expect(
      resolveRoomModelAgentTarget({
        members: twoOwned,
        ownedAgentIds: owners,
        ring: { kind: "ambiguous", botActorIds: ["mine", "mine-too"] },
      }),
    ).toBeNull();
  });

  test("does not target an Agent the viewer does not own", () => {
    expect(
      resolveRoomModelAgentTarget({
        members,
        ownedAgentIds: new Set(),
        ring: { kind: "single", botActorId: "theirs" },
      }),
    ).toBeNull();
  });
});
