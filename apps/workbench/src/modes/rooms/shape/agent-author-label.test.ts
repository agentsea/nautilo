import { describe, expect, test } from "bun:test";
import type { RoomMemberDto } from "@nautilo/types";
import { resolveAssistantAuthorLabel } from "./agent-author-label";

const moxie: RoomMemberDto = {
  actorId: "actor-moxie",
  kind: "agent",
  displayName: "Moxie",
  agentId: "agent-moxie",
  roomRole: "member",
};

describe("assistant author attribution", () => {
  test("renders an external harness as speaker and the Nautilo agent as delegator", () => {
    expect(resolveAssistantAuthorLabel({
      authorAgentId: "agent-moxie",
      authorHarnessId: "claude-code",
      members: [moxie],
      viewerUserId: "viewer",
      fallbackName: "Genie",
      fallbackAvatarSrc: "/genie.png",
      roomId: "room-1",
    })).toEqual({
      name: "Claude Code",
      ownerCue: "via Moxie",
      actorId: null,
      avatarSrc: "",
    });
  });

  test("keeps ordinary assistant messages attributed to their Room agent", () => {
    expect(resolveAssistantAuthorLabel({
      authorAgentId: "agent-moxie",
      authorHarnessId: undefined,
      members: [moxie],
      viewerUserId: "viewer",
      fallbackName: "Genie",
      fallbackAvatarSrc: "/genie.png",
      roomId: "room-1",
    })).toMatchObject({
      name: "Moxie",
      actorId: "actor-moxie",
    });
  });
});
