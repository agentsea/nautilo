/**
 * D421 Phase 4.3 — canonical per-bot wakeability predicate regression.
 *
 * `isAgentWakeable` / `filterWakeableAgents` are the single source of truth
 * reused by the conductor hard-filter and the redirect-target revalidation.
 * This test pins the observe / mute / deaf / membership rules so the two
 * paths cannot drift.
 */
import { describe, expect, test } from "bun:test";
import {
  filterWakeableAgents,
  isAgentWakeable,
  type RoomMemberView,
} from "../../src/conductor/types";

function agent(actorId: string, mode?: "active" | "mention_only" | "observe"): RoomMemberView {
  return { kind: "agent", actorId, handle: actorId, agentResponseMode: mode ?? "active" };
}
function user(actorId: string): RoomMemberView {
  return { kind: "user", actorId, handle: actorId };
}
const W = (botActorId: string | null) => ({ botActorId, kind: "mute" as const });

describe("isAgentWakeable — canonical predicate", () => {
  test("active agent with no silence windows is wakeable", () => {
    expect(isAgentWakeable(agent("a1"), [])).toBe(true);
  });

  test("mention_only agent is wakeable (mention gating is upstream, not here)", () => {
    expect(isAgentWakeable(agent("a2", "mention_only"), [])).toBe(true);
  });

  test("observe agent is never wakeable (permanent mute)", () => {
    expect(isAgentWakeable(agent("a3", "observe"), [])).toBe(false);
  });

  test("humans are never wakeable", () => {
    expect(isAgentWakeable(user("u1"), [])).toBe(false);
  });

  test("per-bot mute window drops the bot", () => {
    expect(isAgentWakeable(agent("a1"), [W("a1")])).toBe(false);
  });

  test("room-wide mute window (botActorId null) drops every bot", () => {
    expect(isAgentWakeable(agent("a1"), [W(null)])).toBe(false);
    expect(isAgentWakeable(agent("a2"), [W(null)])).toBe(false);
  });

  test("a per-bot window does not affect a different bot", () => {
    expect(isAgentWakeable(agent("a1"), [W("a2")])).toBe(true);
  });

  test("deaf window is treated the same as mute (any active window excludes)", () => {
    expect(isAgentWakeable(agent("a1"), [{ botActorId: "a1", kind: "deaf" }])).toBe(false);
  });
});

describe("filterWakeableAgents — roster filter", () => {
  test("filters a mixed roster down to wakeable agents only", () => {
    const roster: RoomMemberView[] = [
      user("u1"),
      agent("a1", "active"),
      agent("a2", "observe"),
      agent("a3", "mention_only"),
    ];
    const wakeable = filterWakeableAgents(roster, []);
    expect(wakeable.map((m) => m.actorId).sort()).toEqual(["a1", "a3"]);
  });

  test("applies per-bot silence windows", () => {
    const roster: RoomMemberView[] = [
      agent("a1", "active"),
      agent("a2", "active"),
      agent("a3", "active"),
    ];
    // a2 is per-bot muted; the room-wide window (null) drops a1 and a3 too.
    const wakeable = filterWakeableAgents(roster, [W("a2"), W(null)]);
    expect(wakeable).toHaveLength(0);
  });
});
