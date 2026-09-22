import { describe, expect, test } from "bun:test";
import type { RoomMemberDto } from "@nautilo/types";
import {
  humanMentionDirectivesToPlainText,
  parseHumanMentionDirective,
  parseHumanMentionDirectiveSegments,
  projectHumanMentionDirectives,
  serializeEveryoneMentionDirective,
  serializeHumanMentionDirective,
} from "../../src/components/composer/human-mention-directives";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const human = (userId: string, handle: string): RoomMemberDto => ({
  actorId: `actor-${userId}`,
  kind: "user",
  displayName: handle,
  handle,
  userId,
  roomRole: "member",
});

const agent = (handle: string): RoomMemberDto => ({
  actorId: `agent-actor-${handle}`,
  kind: "agent",
  displayName: handle,
  handle,
  agentId: `agent-${handle}`,
  roomRole: "member",
});

describe("Human mention directives", () => {
  test("clipboard projection never exposes the stable Human id", () => {
    const directive = serializeHumanMentionDirective(ALICE, "casey");

    expect(
      humanMentionDirectivesToPlainText(`Hello ${directive}, welcome.`),
    ).toBe("Hello @casey, welcome.");
    expect(humanMentionDirectivesToPlainText("plain @casey")).toBe(
      "plain @casey",
    );
  });

  test("round-trips stable Human identity while projecting readable plaintext", () => {
    const directive = serializeHumanMentionDirective(ALICE, "alice");
    expect(parseHumanMentionDirective(directive)).toEqual({
      userId: ALICE,
      handle: "alice",
    });
    expect(parseHumanMentionDirectiveSegments(`Hello ${directive}!`)).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "mention", id: ALICE, label: "alice", type: "user" },
      { kind: "text", text: "!" },
    ]);
    expect(projectHumanMentionDirectives(`Hello ${directive}!`)).toEqual({
      text: "Hello @alice!",
      mentionedHumanUserIds: [ALICE],
    });
  });

  test("deduplicates still-present directives and drops metadata on deletion", () => {
    const alice = serializeHumanMentionDirective(ALICE, "alice");
    const bob = serializeHumanMentionDirective(BOB, "bob");
    expect(
      projectHumanMentionDirectives(`${alice} ${bob} ${alice}`),
    ).toEqual({
      text: "@alice @bob @alice",
      mentionedHumanUserIds: [ALICE, BOB],
    });
    expect(projectHumanMentionDirectives(bob).mentionedHumanUserIds).toEqual([
      BOB,
    ]);
  });

  test("projects the room audience directive to readable text and drops intent on deletion", () => {
    const everyone = serializeEveryoneMentionDirective();
    expect(projectHumanMentionDirectives(`Hello ${everyone}.`)).toEqual({
      text: "Hello @everyone.",
      mentionedHumanUserIds: [],
      mentionEveryone: true,
    });
    expect(projectHumanMentionDirectives("Hello .")).toEqual({
      text: "Hello .",
      mentionedHumanUserIds: [],
    });
  });

  test("recognizes standalone typed or pasted audience mentions outside code", () => {
    expect(projectHumanMentionDirectives("typed @everyone and pasted (@everyone)."))
      .toMatchObject({ mentionEveryone: true });
    expect(projectHumanMentionDirectives("`@everyone @[everyone]`\n```txt\n@everyone\n@[everyone]\n```"))
      .toEqual({
        text: "`@everyone @everyone`\n```txt\n@everyone\n@everyone\n```",
        mentionedHumanUserIds: [],
      });
    expect(projectHumanMentionDirectives(
      "x@everyone @@everyone @everyone-home @everyone.example @everyone@example.com",
    )).toEqual({
      text: "x@everyone @@everyone @everyone-home @everyone.example @everyone@example.com",
      mentionedHumanUserIds: [],
    });
  });

  test("keeps a selected Human named everyone distinct and supports direct plus room audience", () => {
    const namedEveryone = serializeHumanMentionDirective(ALICE, "everyone");
    expect(projectHumanMentionDirectives(namedEveryone)).toEqual({
      text: "@everyone",
      mentionedHumanUserIds: [ALICE],
    });
    expect(projectHumanMentionDirectives(
      `${serializeHumanMentionDirective(BOB, "bob")} ${serializeEveryoneMentionDirective()}`,
    )).toEqual({
      text: "@bob @everyone",
      mentionedHumanUserIds: [BOB],
      mentionEveryone: true,
    });
  });

  test("resolves exact plaintext handles against current Human members", () => {
    expect(
      projectHumanMentionDirectives(
        "manual @alice, pasted @bob, and @alice again",
        [human(ALICE, "alice"), human(BOB, "bob")],
      ),
    ).toEqual({
      text: "manual @alice, pasted @bob, and @alice again",
      mentionedHumanUserIds: [ALICE, BOB],
    });
    expect(
      parseHumanMentionDirectiveSegments("manual @alice and pasted @bob"),
    ).toBeNull();
  });

  test("unions plaintext and picker identity without reparsing the directive label", () => {
    const alicePicker = serializeHumanMentionDirective(ALICE, "old_alice");
    expect(
      projectHumanMentionDirectives(`${alicePicker}, @alice, and @bob`, [
        human(ALICE, "alice"),
        human(BOB, "bob"),
      ]),
    ).toEqual({
      text: "@old_alice, @alice, and @bob",
      mentionedHumanUserIds: [ALICE, BOB],
    });
  });

  test("keeps unknown, Agent-only, and ambiguous Human handles ambient", () => {
    expect(
      projectHumanMentionDirectives("@unknown @genie @alice", [
        agent("genie"),
        human(ALICE, "alice"),
        human(BOB, "alice"),
      ]),
    ).toEqual({
      text: "@unknown @genie @alice",
      mentionedHumanUserIds: [],
    });
  });

  test("rejects malformed, embedded, email, and federated-looking tokens", () => {
    expect(
      projectHumanMentionDirectives(
        "@Alice x@alice @@alice @alice-smith @alice.example @alice@example",
        [human(ALICE, "alice")],
      ).mentionedHumanUserIds,
    ).toEqual([]);
  });

  test("ignores plaintext handles in inline and fenced code", () => {
    expect(
      projectHumanMentionDirectives(
        "say `@alice` or:\n```\n@alice\n```\nbut notify @bob.",
        [human(ALICE, "alice"), human(BOB, "bob")],
      ).mentionedHumanUserIds,
    ).toEqual([BOB]);
  });

  test("requires canonical roster handles and accepts punctuation boundaries", () => {
    expect(
      projectHumanMentionDirectives("(@alice), then @invalid.", [
        human(ALICE, "alice"),
        human(BOB, "Invalid"),
      ]).mentionedHumanUserIds,
    ).toEqual([ALICE]);
  });
});
