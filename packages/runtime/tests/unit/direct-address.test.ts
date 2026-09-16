import { describe, test, expect } from "bun:test";
import {
  findDirectAddressMatches,
  normDirectAddressName,
  type RoomMemberView,
} from "@nautilo/runtime";

function agent(
  actorId: string,
  handle: string,
  displayName?: string,
): RoomMemberView {
  return {
    kind: "agent",
    actorId,
    agentId: `agent-${actorId}`,
    handle,
    ...(displayName ? { displayName } : {}),
    agentResponseMode: "mention_only",
  };
}

describe("findDirectAddressMatches (D299 P1)", () => {
  const JEANNIE = "actor-jeannie";

  test("unique handle match — comma form", () => {
    const matches = findDirectAddressMatches("Jeannie, are you around?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      actorId: JEANNIE,
      handle: "jeannie",
      matchedAs: "handle",
    });
  });

  test("unique handle match — space form", () => {
    const matches = findDirectAddressMatches("Jeannie are you around?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("unique handle match — hey comma form", () => {
    const matches = findDirectAddressMatches("hey Jeannie, are you around?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("hey form without comma is rejected", () => {
    const matches = findDirectAddressMatches("hey Jeannie are you around?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(0);
  });

  test("mid-sentence name is rejected", () => {
    const matches = findDirectAddressMatches(
      "I was talking about Jeannie yesterday",
      [agent(JEANNIE, "jeannie")],
    );
    expect(matches).toHaveLength(0);
  });

  test("display-name match when distinct from handle", () => {
    const matches = findDirectAddressMatches("Genie, can you help?", [
      agent("actor-genie", "genie-bot", "Genie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      actorId: "actor-genie",
      matchedAs: "displayName",
      matchedName: "Genie",
    });
  });

  test("collision — two agents share the same display name", () => {
    const a = "actor-jeannie-a";
    const b = "actor-jeannie-b";
    const matches = findDirectAddressMatches("Jeannie, are you around?", [
      agent(a, "jeannie-a", "Jeannie"),
      agent(b, "jeannie-b", "Jeannie"),
    ]);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.actorId).sort()).toEqual([a, b].sort());
  });

  test("longest roster name wins for multi-word display names", () => {
    const matches = findDirectAddressMatches("Genie Bot, ping", [
      agent("actor-short", "genie", "Genie"),
      agent("actor-long", "genie-bot", "Genie Bot"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe("actor-long");
  });

  test("bare hey without roster name is not evidence", () => {
    const matches = findDirectAddressMatches("hey everyone", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(0);
  });

  test("humans in roster are ignored", () => {
    const matches = findDirectAddressMatches("Alice, hi", [
      { kind: "user", actorId: "user-alice", handle: "alice", displayName: "Alice" },
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(0);
  });

  test("normDirectAddressName strips @ and lowercases", () => {
    expect(normDirectAddressName("@Jeannie")).toBe("jeannie");
    expect(normDirectAddressName("  Nova  ")).toBe("nova");
  });
});

// D421 Phase 6.1.1 — natural unique roster-address forms. These extend the
// leading-vocative contract to discourse-prefixed, presence-question, and
// turn-yielding shapes that name exactly one roster agent. Exact token
// boundaries only; no fuzzy/phonetic matching. Each form must produce exactly
// one addressee match so the Conductor can route deterministically.
describe("findDirectAddressMatches — natural named-agent address (D421 6.1.1)", () => {
  const JEANNIE = "actor-jeannie";
  const ALEPO = "actor-alepo";

  test("discourse-prefixed 'And Jeannie ...' (no comma) wakes unique agent", () => {
    const matches = findDirectAddressMatches("And Jeannie are you around?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("discourse-prefixed 'And Jeannie, ...' (comma) wakes unique agent", () => {
    const matches = findDirectAddressMatches("And Jeannie, what about you?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("presence question 'is Jeannie here?' wakes unique agent", () => {
    const matches = findDirectAddressMatches("is Jeannie here?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("presence question 'is Jeannie around?' wakes unique agent", () => {
    const matches = findDirectAddressMatches("is Jeannie around?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("presence question 'is Jeannie available?' wakes unique agent", () => {
    const matches = findDirectAddressMatches("is Jeannie available?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("discourse + presence 'now is Jeannie here?' wakes unique agent", () => {
    const matches = findDirectAddressMatches("now is Jeannie here?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("live phrase family 'Good and now is Jeannie here?' wakes unique agent", () => {
    const matches = findDirectAddressMatches("Good and now is Jeannie here?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("turn-yielding '... and Jeannie, what about you?' wakes unique agent", () => {
    const matches = findDirectAddressMatches(
      "thanks for that, and Jeannie, what about you?",
      [agent(JEANNIE, "jeannie")],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("natural unique named address outranks a different agent named mid-sentence", () => {
    // Leading vocative "Alepo," is the addressee; "Jeannie" is a mid-sentence
    // topic and must NOT also be returned as an addressee.
    const matches = findDirectAddressMatches("Alepo, what did Jeannie say?", [
      agent(JEANNIE, "jeannie"),
      agent(ALEPO, "alepo"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(ALEPO);
  });
});

// D421 Phase 6.1.2 — negative/ambiguous controls. Incidental references,
// quoted/hypothetical mentions, two named agents, same-name agents, and a
// human/agent name collision must NOT become an unconditional wake, and
// ambiguous cases must not pick arbitrarily.
describe("findDirectAddressMatches — incidental / ambiguous negatives (D421 6.1.2)", () => {
  const JEANNIE = "actor-jeannie";
  const ALEPO = "actor-alepo";

  test("incidental past-tense reference is not an addressee", () => {
    const matches = findDirectAddressMatches(
      "I was talking about Jeannie yesterday",
      [agent(JEANNIE, "jeannie")],
    );
    expect(matches).toHaveLength(0);
  });

  test("quoted/hypothetical 'if I say, Hey Genie, ...' is not an addressee", () => {
    const matches = findDirectAddressMatches(
      'if I say, "Hey Genie, let\'s see" does that wake you?',
      [agent("actor-genie", "genie", "Genie")],
    );
    expect(matches).toHaveLength(0);
  });

  test("two named agents addressed together are ambiguous (2 matches)", () => {
    const matches = findDirectAddressMatches(
      "Jeannie and Alepo, are you two around?",
      [agent(JEANNIE, "jeannie"), agent(ALEPO, "alepo")],
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.actorId).sort()).toEqual([ALEPO, JEANNIE].sort());
  });

  test("same-name agents on a natural address are ambiguous (2 matches)", () => {
    const a = "actor-jeannie-a";
    const b = "actor-jeannie-b";
    const matches = findDirectAddressMatches("And Jeannie, are you around?", [
      agent(a, "jeannie-a", "Jeannie"),
      agent(b, "jeannie-b", "Jeannie"),
    ]);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.actorId).sort()).toEqual([a, b].sort());
  });

  test("human/agent name collision: agent match returned, human ignored", () => {
    const matches = findDirectAddressMatches("is Jeannie here?", [
      { kind: "user", actorId: "user-jeannie", handle: "jeannie-h", displayName: "Jeannie" },
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.actorId).toBe(JEANNIE);
  });

  test("bare discourse marker without a roster name is not evidence", () => {
    const matches = findDirectAddressMatches("and now is everyone here?", [
      agent(JEANNIE, "jeannie"),
    ]);
    expect(matches).toHaveLength(0);
  });
});
