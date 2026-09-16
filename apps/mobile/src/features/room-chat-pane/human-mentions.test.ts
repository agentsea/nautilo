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
    expect(mobileMentionCandidates([casey, jeannie], casey.actorId)).toEqual([
      { actorId: jeannie.actorId, kind: "agent", displayName: "Jeannie", handle: "jeannie" },
    ]);
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
