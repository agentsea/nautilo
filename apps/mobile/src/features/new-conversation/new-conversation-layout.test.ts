import { describe, expect, test } from "bun:test";

const routeSource = await Bun.file(
  new URL("../../app/chat/new.tsx", import.meta.url),
).text();
const chatsSource = await Bun.file(
  new URL("../../app/(drawer)/(tabs)/index.tsx", import.meta.url),
).text();

describe("mobile new-conversation layout contract", () => {
  test("uses explicit Direct, Group, and Room journeys without hidden long-press modes", () => {
    expect(routeSource).toContain('title="Direct message"');
    expect(routeSource).toContain('title="New group"');
    expect(routeSource).toContain('title="New room"');
    expect(routeSource).not.toContain("onLongPress");
  });

  test("virtualizes the directory and keeps one create action outside it", () => {
    expect(routeSource).toContain("<FlatList");
    expect(routeSource).toContain("onEndReached=");
    expect(routeSource).toContain("<View style={styles.fixedFooter}>");
    expect(routeSource).toContain("<KeyboardAvoidingView");
    expect(routeSource).toContain('behavior="height"');
    expect(routeSource).toContain("automaticOffset");
    expect(routeSource).toContain("revealHeaderControl");
    expect(routeSource).toContain("scrollToOffset");
    expect(routeSource).not.toContain("<KeyboardStickyView");
    expect(routeSource.match(/Create group/g)?.length).toBe(1);
    expect(routeSource.match(/Create room/g)?.length).toBe(1);
    expect(routeSource).not.toContain("<ScrollView");
  });

  test("keeps one fixed New chat launcher on the conversation list", () => {
    expect(chatsSource).toContain('accessibilityLabel="New conversation"');
    expect(chatsSource).toContain("styles.newConversationButton");
    expect(chatsSource).not.toContain("rightExtra={composeButton}");
  });

  test("presents human conversation concepts instead of dispatch machinery", () => {
    expect(chatsSource).toContain('(["all", "chats", "group-chats", "archive"] as const)');
    expect(chatsSource).toContain('f === "group-chats" ? "Group Chats" : "Archive"');
    expect(chatsSource).toContain('(["genies", "people"] as const)');
    expect(chatsSource).toContain('filter === "group-chats"');
    expect(chatsSource).not.toContain('f === "rooms" ? "Rooms"');
    expect(chatsSource).not.toContain('"Direct"');
    expect(chatsSource).not.toContain('"Groups"');
    expect(routeSource).toContain('catalogueKind: mode === "room" ? "room" : "chat"');
  });

  test("reuses Human DMs but starts a fresh chat with any available Server Genie", () => {
    expect(routeSource).toContain("directHumanUserId: entry.id");
    expect(routeSource).toContain('{ kind: "agent", id: entry.id }');
    expect(routeSource).not.toContain("personalAgentId: entry.id");
    expect(routeSource).not.toContain('agentScope: "owned"');
    expect(routeSource).toContain("choose a Genie to start a fresh chat");
  });
});
