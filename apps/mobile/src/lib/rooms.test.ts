import { describe, expect, test } from "bun:test";
import type { RoomSummaryDto, RoomSummaryRosterMemberDto } from "@nautilo/types";
import {
  conversationCatalogueKind,
  conversationCatalogueLabel,
  conversationMatchesQuery,
  isConversationVisibleToViewer,
  isGroupChatConversation,
} from "./rooms";

const VIEWER = "user-viewer";
const viewer: RoomSummaryRosterMemberDto = {
  actorId: "actor-viewer",
  kind: "user",
  displayName: "You",
  userId: VIEWER,
};
const person: RoomSummaryRosterMemberDto = {
  actorId: "actor-casey",
  kind: "user",
  displayName: "Casey",
  userId: "user-casey",
};
const genie: RoomSummaryRosterMemberDto = {
  actorId: "actor-jeannie",
  kind: "agent",
  displayName: "Jeannie",
  agentId: "agent-jeannie",
};

function room(overrides: Partial<RoomSummaryDto> = {}): RoomSummaryDto {
  return {
    id: "room-1",
    label: "Conversation",
    type: "private",
    graphThreadId: "room:room-1",
    createdAt: "2026-08-13T00:00:00.000Z",
    memberCount: 2,
    kind: "private",
    roster: [viewer, person],
    ...overrides,
  };
}

describe("human-facing conversation catalogue", () => {
  test("places explicit public and private named spaces in Rooms", () => {
    expect(conversationCatalogueKind(room({ kind: "open", type: "shared" }), VIEWER)).toBe("room");
    expect(conversationCatalogueKind(room({ kind: "private", type: "room" }), VIEWER)).toBe("room");
    expect(conversationCatalogueLabel(room({ kind: "open" }), VIEWER)).toBe("Public room");
    expect(conversationCatalogueLabel(room({ type: "room" }), VIEWER)).toBe("Private room");
  });

  test("splits exact 1:1 Human and Genie chats by the other participant", () => {
    expect(conversationCatalogueKind(room({ roster: [viewer, person] }), VIEWER)).toBe("person");
    expect(conversationCatalogueKind(room({ roster: [viewer, genie] }), VIEWER)).toBe("genie");
    expect(conversationCatalogueLabel(room({ roster: [viewer, person] }), VIEWER)).toBe("Person");
    expect(conversationCatalogueLabel(room({ roster: [viewer, genie] }), VIEWER)).toBe("Genie");
  });

  test("places every multi-participant or mixed participant chat in Group chats", () => {
    expect(
      conversationCatalogueKind(
        room({ memberCount: 3, kind: "group", roster: [viewer, person, genie] }),
        VIEWER,
      ),
    ).toBe("group");
    expect(conversationCatalogueLabel(room({ roster: [viewer, person, genie] }), VIEWER)).toBe(
      "Group chat",
    );
  });

  test("keeps every group and named channel together in the Group Chats filter", () => {
    expect(isGroupChatConversation(
      room({ kind: "group", roster: [viewer, person, genie] }),
      VIEWER,
    )).toBe(true);
    expect(isGroupChatConversation(
      room({ kind: "multi_agent", roster: [viewer, person, genie] }),
      VIEWER,
    )).toBe(true);
    expect(isGroupChatConversation(room({ kind: "open", type: "shared" }), VIEWER)).toBe(true);
    expect(isGroupChatConversation(room({ kind: "private", type: "room" }), VIEWER)).toBe(true);
    expect(isGroupChatConversation(room({ roster: [viewer, person] }), VIEWER)).toBe(false);
    expect(isGroupChatConversation(room({ roster: [viewer, genie] }), VIEWER)).toBe(false);
  });

  test("fails ambiguous legacy data into Group chats instead of inventing a 1:1", () => {
    expect(conversationCatalogueKind(room({ roster: undefined }), VIEWER)).toBe("group");
    expect(conversationCatalogueKind(room(), undefined)).toBe("group");
    expect(conversationCatalogueKind(room({ roster: [person, genie] }), VIEWER)).toBe("group");
  });

  test("hides only strict Human-Agent chats when Agent invocation is unavailable", () => {
    expect(isConversationVisibleToViewer(room({ roster: [viewer, genie] }), VIEWER, false)).toBe(false);
    expect(isConversationVisibleToViewer(room({ roster: [viewer, person] }), VIEWER, false)).toBe(true);
    expect(isConversationVisibleToViewer(
      room({ kind: "group", roster: [viewer, person, genie] }),
      VIEWER,
      false,
    )).toBe(true);
    expect(isConversationVisibleToViewer(room({ roster: [viewer, genie] }), VIEWER, true)).toBe(true);
  });

  test("searches the current catalogue by room and projected participant identity", () => {
    const caseyRoom = room({ label: "Launch planning", roster: [viewer, person] });
    expect(conversationMatchesQuery(caseyRoom, "launch")).toBe(true);
    expect(conversationMatchesQuery(caseyRoom, "CASEY")).toBe(true);
    expect(conversationMatchesQuery(caseyRoom, "missing")).toBe(false);
    expect(conversationMatchesQuery(caseyRoom, "  ")).toBe(true);
  });
});
