import { describe, expect, test } from "bun:test";
import type { RoomMemberDto } from "@nautilo/types";

import { mobileMentionCandidates, projectMobileHumanMentions } from "./human-mentions";

const casey: RoomMemberDto = {
  actorId: "casey-actor",
  kind: "user",
  userId: "37fd3595-dbe6-4e98-8a0f-d4b0ee9c4d5e",
  displayName: "Casey",
  handle: "casey",
  roomRole: "member",
};
const jeannie: RoomMemberDto = {
  actorId: "jeannie-actor",
  kind: "agent",
  agentId: "jeannie-agent",
  displayName: "Jeannie",
  handle: "jeannie",
  roomRole: "member",
};

describe("mobile Room Human mentions", () => {
  test("suggestions come from canonical roster handles and exclude the viewer", () => {
    expect(mobileMentionCandidates([casey, jeannie], casey.actorId, true)).toEqual([
      {
        actorId: "room-audience-everyone",
        kind: "audience",
        displayName: "@everyone — Notify everyone in this room",
        handle: "everyone",
      },
      { actorId: jeannie.actorId, kind: "agent", displayName: "Jeannie", handle: "jeannie" },
    ]);
  });

  test("gates the room audience while retaining ordinary individual suggestions", () => {
    const namedEveryone: RoomMemberDto = {
      ...casey,
      actorId: "everyone-actor",
      userId: "11111111-1111-4111-8111-111111111111",
      displayName: "Everyone Person",
      handle: "everyone",
    };
    const genieEveryone: RoomMemberDto = {
      ...jeannie,
      actorId: "everyone-genie-actor",
      displayName: "Everyone Genie",
      handle: "everyone",
    };
    expect(mobileMentionCandidates([casey, namedEveryone, genieEveryone], null, false)).toEqual([{
      actorId: casey.actorId,
      kind: "user",
      displayName: "Casey",
      handle: "casey",
    }]);
    expect(mobileMentionCandidates([casey, namedEveryone, genieEveryone], null, true)).toEqual([
      {
        actorId: "room-audience-everyone",
        kind: "audience",
        displayName: "@everyone — Notify everyone in this room",
        handle: "everyone",
      },
      {
        actorId: casey.actorId,
        kind: "user",
        displayName: "Casey",
        handle: "casey",
      },
    ]);
    expect(projectMobileHumanMentions("@everyone", [namedEveryone])).toEqual({
      content: "@everyone",
      mentionedHumanUserIds: [],
      mentionEveryone: true,
    });
  });

  test("typed and pasted room audience mentions set only the audience flag", () => {
    expect(projectMobileHumanMentions("Please look, @everyone.", [casey])).toEqual({
      content: "Please look, @everyone.",
      mentionedHumanUserIds: [],
      mentionEveryone: true,
    });
  });

  test("ignores audience-looking text in code, emails, federated tokens, and embedded words", () => {
    const text = "`@everyone` ```\n@everyone\n``` x@everyone @@everyone @everyone-home @everyone.example @everyone@example.com";
    expect(projectMobileHumanMentions(text, [casey])).toEqual({
      content: text,
      mentionedHumanUserIds: [],
    });
  });

  test("supports a direct Human mention together with the room audience and removes absent intent", () => {
    expect(projectMobileHumanMentions("@casey and @everyone", [casey])).toEqual({
      content: "@casey and @everyone",
      mentionedHumanUserIds: [casey.userId!],
      mentionEveryone: true,
    });
    expect(projectMobileHumanMentions("everyone", [casey])).toEqual({
      content: "everyone",
      mentionedHumanUserIds: [],
    });
  });

  test("an exact Human handle sends readable text plus the structured recipient", () => {
    expect(projectMobileHumanMentions("Can you review this, @casey?", [casey, jeannie])).toEqual({
      content: "Can you review this, @casey?",
      mentionedHumanUserIds: [casey.userId!],
    });
  });

  test("does not infer mention delivery from code or an ambiguous roster handle", () => {
    const duplicate: RoomMemberDto = { ...casey, actorId: "other", userId: "620dd3bc-7b6d-4a5c-baa4-4d709c9e3d75" };
    expect(projectMobileHumanMentions("`@casey`", [casey])).toEqual({
      content: "`@casey`",
      mentionedHumanUserIds: [],
    });
    expect(projectMobileHumanMentions("@casey", [casey, duplicate]).mentionedHumanUserIds).toEqual([]);
  });
});
