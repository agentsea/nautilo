import { describe, expect, test } from "bun:test";

import {
  agentFinderMetadata,
  agentOwnerLabel,
  agentRailSecondaryLabel,
  agentRailOverflows,
  filterAgentFinderEntries,
  orderAgentsByRecentUse,
} from "./agent-focus-bar-model";
import type { RoomMemberDto } from "@nautilo/types";

function agent(overrides: Partial<RoomMemberDto> = {}): RoomMemberDto {
  return {
    actorId: "actor-a",
    kind: "agent",
    displayName: "Genie",
    handle: "casey-genie",
    agentId: "agent-a",
    roomRole: "member",
    agentOwnerDisplayName: "Casey",
    agentOwnerHandle: "casey",
    ...overrides,
  };
}

describe("agent focus bar identity", () => {
  test("keeps the Genie name primary and derives a compact owner label", () => {
    expect(agentOwnerLabel(agent())).toBe("Casey");
    expect(agentFinderMetadata(agent())).toBe("Casey · @casey-genie");
  });

  test("falls back through owner handle and Genie handle", () => {
    expect(agentOwnerLabel(agent({ agentOwnerDisplayName: null }))).toBe("@casey");
    expect(agentOwnerLabel(agent({
      agentOwnerDisplayName: null,
      agentOwnerHandle: null,
    }))).toBe("@casey-genie");
  });

  test("adds the Genie handle only when name and owner still collide", () => {
    const first = agent();
    const second = agent({ actorId: "actor-b", agentId: "agent-b", handle: "casey-work" });

    expect(agentRailSecondaryLabel(first, [first])).toBe("Casey");
    expect(agentRailSecondaryLabel(first, [first, second])).toBe("Casey · @casey-genie");
    expect(agentRailSecondaryLabel(second, [first, second])).toBe("Casey · @casey-work");
  });

  test("searching the shared default name returns every matching Genie", () => {
    const agents = [
      agent(),
      agent({ actorId: "actor-b", agentId: "agent-b", handle: "taylor-genie", agentOwnerDisplayName: "Taylor" }),
      agent({ actorId: "actor-c", agentId: "agent-c", displayName: "Nova", handle: "nova", agentOwnerDisplayName: "Alex" }),
    ];

    expect(filterAgentFinderEntries(agents, "genie").map((entry) => entry.actorId)).toEqual([
      "actor-a",
      "actor-b",
    ]);
    expect(filterAgentFinderEntries(agents, "alex").map((entry) => entry.actorId)).toEqual([
      "actor-c",
    ]);
  });

  test("moves the most recently toggled Genie to the front without disturbing the rest", () => {
    const first = agent({ actorId: "actor-a", displayName: "Alpha" });
    const second = agent({ actorId: "actor-b", displayName: "Beta" });
    const third = agent({ actorId: "actor-c", displayName: "Gamma" });

    expect(orderAgentsByRecentUse([first, second, third], ["actor-c"]).map((entry) => entry.actorId)).toEqual([
      "actor-c",
      "actor-a",
      "actor-b",
    ]);
    expect(orderAgentsByRecentUse([first, second, third], ["actor-b", "actor-c"]).map((entry) => entry.actorId)).toEqual([
      "actor-b",
      "actor-c",
      "actor-a",
    ]);
  });

  test("shows Find only for measured overflow", () => {
    expect(agentRailOverflows(320, 320)).toBe(false);
    expect(agentRailOverflows(321, 320)).toBe(true);
  });
});
