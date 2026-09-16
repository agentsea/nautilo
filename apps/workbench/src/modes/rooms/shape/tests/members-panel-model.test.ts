import { describe, expect, it } from "bun:test";
import {
  isGroupRoom,
  usesMembersManagerPanel,
  memberTypeSuffix,
  resolveFocusRing,
  isRingTarget,
  isHeldFocus,
  sortMembersByTalking,
  type ActiveFocusLite,
  type SortableMember,
} from "../members-panel-model";

describe("isGroupRoom (D278 trigger)", () => {
  const u = { kind: "user" as const };
  const a = { kind: "agent" as const };
  it("1 human + 1 bot DM is NOT a group room", () => {
    expect(isGroupRoom([u, a])).toBe(false);
  });
  it(">1 human is a group room", () => {
    expect(isGroupRoom([u, u, a])).toBe(true);
  });
  it(">1 agent is a group room", () => {
    expect(isGroupRoom([u, a, a])).toBe(true);
  });
  it("solo / empty is not a group room", () => {
    expect(isGroupRoom([u])).toBe(false);
    expect(isGroupRoom([])).toBe(false);
  });
});

describe("usesMembersManagerPanel", () => {
  const u = { kind: "user" as const };
  const a = { kind: "agent" as const };

  it("preserves the Agent soul panel for a direct Human-Agent chat", () => {
    expect(usesMembersManagerPanel([u, a])).toBe(false);
  });

  it("shows room members for Human-only rooms at every roster size", () => {
    expect(usesMembersManagerPanel([u])).toBe(true);
    expect(usesMembersManagerPanel([u, u])).toBe(true);
    expect(usesMembersManagerPanel([u, u, u])).toBe(true);
  });

  it("shows room members for multi-Human and multi-Agent group rooms", () => {
    expect(usesMembersManagerPanel([u, u, a])).toBe(true);
    expect(usesMembersManagerPanel([u, a, a])).toBe(true);
  });

  it("does not claim the panel before a roster is available", () => {
    expect(usesMembersManagerPanel([])).toBe(false);
  });
});

describe("memberTypeSuffix (D278 §4.7.4 — binary H/G)", () => {
  it("maps a human to H and an agent (Genie) to G", () => {
    expect(memberTypeSuffix({ kind: "user" })).toBe("H");
    expect(memberTypeSuffix({ kind: "agent" })).toBe("G");
  });
});

describe("resolveFocusRing (D278 §4.7.4 — ring = single routing target)", () => {
  const now = 1_000_000;
  const focus = (botActorId: string, dtMs: number): ActiveFocusLite => ({
    botActorId,
    expiresAt: now + dtMs,
  });

  it("none when no active foci", () => {
    expect(resolveFocusRing([], now)).toEqual({ kind: "none" });
  });

  it("ignores expired foci", () => {
    expect(resolveFocusRing([focus("a1", -1)], now)).toEqual({ kind: "none" });
  });

  it("single ring when exactly one active focus", () => {
    expect(resolveFocusRing([focus("a1", 5000)], now)).toEqual({
      kind: "single",
      botActorId: "a1",
    });
  });

  it("ambiguous (no single ring) when several active foci", () => {
    const ring = resolveFocusRing([focus("a1", 5000), focus("a2", 9000)], now);
    expect(ring.kind).toBe("ambiguous");
    expect(ring.kind === "ambiguous" && ring.botActorIds).toEqual(["a1", "a2"]);
  });

  it("isRingTarget only for the single target; isHeldFocus only in ambiguous", () => {
    const single = resolveFocusRing([focus("a1", 5000)], now);
    expect(isRingTarget(single, "a1")).toBe(true);
    expect(isHeldFocus(single, "a1")).toBe(false);

    const amb = resolveFocusRing([focus("a1", 5000), focus("a2", 9000)], now);
    expect(isRingTarget(amb, "a1")).toBe(false);
    expect(isHeldFocus(amb, "a2")).toBe(true);
  });
});

describe("sortMembersByTalking (D278 §4.7.4)", () => {
  const m = (actorId: string, roomRole: "admin" | "member", displayName: string): SortableMember => ({
    actorId,
    roomRole,
    displayName,
  });

  it("floats most-recently-talking to the top, then admins, then alpha", () => {
    const members = [
      m("a", "member", "Zara"),
      m("b", "admin", "Bob"),
      m("c", "member", "Maya"),
      m("d", "member", "Nova"),
    ];
    const spoke = new Map<string, number>([
      ["c", 300], // Maya spoke most recently
      ["a", 100],
    ]);
    const order = sortMembersByTalking(members, spoke).map((x) => x.actorId);
    // Maya (recent) then Zara (recent), then admin Bob, then Nova (alpha among silent)
    expect(order).toEqual(["c", "a", "b", "d"]);
  });

  it("is a pure copy (does not mutate input)", () => {
    const members = [m("a", "member", "Zara"), m("b", "admin", "Bob")];
    const copy = [...members];
    sortMembersByTalking(members, new Map());
    expect(members).toEqual(copy);
  });
});
