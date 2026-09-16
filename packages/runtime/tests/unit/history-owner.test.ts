import { describe, test, expect } from "bun:test";
import {
  deterministicHistoryOwner,
  historyBotOwners,
  messageNeedsHistory,
  type RoomHistoryHit,
  type RoomMemberView,
} from "@nautilo/runtime";
import type { ActiveFocus } from "@nautilo/trust";

function agent(actorId: string, handle: string, mode: RoomMemberView["agentResponseMode"] = "active"): RoomMemberView {
  return { kind: "agent", actorId, agentId: `agent-${actorId}`, handle, agentResponseMode: mode };
}

function hit(authorActorId: string, handle: string): RoomHistoryHit {
  return {
    messageId: Math.floor(Math.random() * 1000),
    ts: new Date(),
    authorDisplayName: handle,
    handle,
    authorActorId,
    snippet: "snippet",
  };
}

function focus(botActorId: string): ActiveFocus {
  return { focusId: `f-${botActorId}`, botActorId, expiresAt: new Date(Date.now() + 60_000), openedSource: "mention" };
}

describe("deterministicHistoryOwner", () => {
  const NOVA = "actor-nova";
  const ALEPO = "actor-alepo";
  const USER = "actor-user";

  test("single candidate-bot author → that bot", () => {
    const owner = deterministicHistoryOwner(
      [hit(NOVA, "nova"), hit(NOVA, "nova")],
      [],
      [agent(NOVA, "nova"), agent(ALEPO, "alepo")],
    );
    expect(owner).toBe(NOVA);
  });

  test("two distinct bot authors → null (tie)", () => {
    const owner = deterministicHistoryOwner(
      [hit(NOVA, "nova"), hit(ALEPO, "alepo")],
      [],
      [agent(NOVA, "nova"), agent(ALEPO, "alepo")],
    );
    expect(owner).toBeNull();
  });

  test("only human-authored hits → null", () => {
    const owner = deterministicHistoryOwner(
      [hit(USER, "sender")],
      [],
      [agent(NOVA, "nova")],
    );
    expect(owner).toBeNull();
  });

  test("no hits → null", () => {
    expect(deterministicHistoryOwner([], [], [agent(NOVA, "nova")])).toBeNull();
  });

  test("active-focus mention_only bot counts as wakeable owner", () => {
    const owner = deterministicHistoryOwner(
      [hit(NOVA, "nova")],
      [focus(NOVA)],
      [agent(NOVA, "nova", "mention_only")],
    );
    expect(owner).toBe(NOVA);
  });

  test("author not in candidate set (e.g. muted, excluded upstream) → null", () => {
    const owner = deterministicHistoryOwner(
      [hit("actor-muted", "muted")],
      [],
      [agent(NOVA, "nova")],
    );
    expect(owner).toBeNull();
  });
});

describe("historyBotOwners", () => {
  const NOVA = "actor-nova";
  const ALEPO = "actor-alepo";

  test("returns all distinct wakeable bot authors", () => {
    const owners = historyBotOwners(
      [hit(NOVA, "nova"), hit(ALEPO, "alepo")],
      [],
      [agent(NOVA, "nova"), agent(ALEPO, "alepo")],
    );
    expect(owners.sort()).toEqual([ALEPO, NOVA].sort());
  });

  test("single author → one-element array", () => {
    expect(
      historyBotOwners([hit(NOVA, "nova")], [], [agent(NOVA, "nova")]),
    ).toEqual([NOVA]);
  });

  test("no wakeable authors → empty", () => {
    expect(historyBotOwners([], [], [agent(NOVA, "nova")])).toEqual([]);
  });
});

describe("messageNeedsHistory (conservative, structural-only)", () => {
  test("no reply, no flag → false", () => {
    expect(messageNeedsHistory({ content: "anything" })).toBe(false);
  });

  test("explicit searchHistoryFlag → true", () => {
    expect(messageNeedsHistory({ content: "x" }, { searchHistoryFlag: true })).toBe(true);
  });

  test("reply to the immediately-preceding turn → false (ordinary reply)", () => {
    expect(
      messageNeedsHistory({ content: "x", replyToMessageId: 100 }, { precedingMessageId: 100 }),
    ).toBe(false);
  });

  test("reply to an OLDER message → true (past-context lookup)", () => {
    expect(
      messageNeedsHistory({ content: "x", replyToMessageId: 40 }, { precedingMessageId: 100 }),
    ).toBe(true);
  });

  test("reply with unknown preceding turn → false (conservative)", () => {
    expect(messageNeedsHistory({ content: "x", replyToMessageId: 40 })).toBe(false);
  });
});
