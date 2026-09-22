import { afterAll, beforeAll, describe, expect, test, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup } from "@testing-library/react";
import { Window } from "happy-dom";
import type { RoomMemberDto } from "@nautilo/types";
import type { Unstable_TriggerItem } from "@assistant-ui/core";
import {
  applyLexicalComposerAccessibility,
  buildMemberByHandle,
  EVERYONE_MENTION_ITEM_ID,
  mentionHandleForMember,
  mentionAtHandleFormatter,
  mentionItemsForRoom,
  MentionSuggestionRow,
} from "../../src/components/composer/MentionAdapter";
import { projectResourceDirectives } from "../../src/components/composer/resource-directives";
import { projectHumanMentionDirectives } from "../../src/components/composer/human-mention-directives";
import {
  buildLastSpokeAtMsFromThread,
  compareMentionMembersByRecency,
  sortMembersForMentionPicker,
} from "../../src/components/composer/mention-recency";

const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};

mock.module("../../src/components/avatar/UserAvatar", () => ({
  UserAvatar: ({ userId }: { userId: string }) => (
    <span data-testid="user-avatar" data-user-id={userId} />
  ),
}));

const human = (
  actorId: string,
  name: string,
  userId = actorId,
  handle?: string,
): RoomMemberDto => ({
  actorId,
  kind: "user",
  displayName: name,
  userId,
  roomRole: "member",
  ...(handle ? { handle } : {}),
});

const agent = (actorId: string, name: string, handle?: string): RoomMemberDto => ({
  actorId,
  kind: "agent",
  displayName: name,
  agentId: actorId,
  roomRole: "member",
  ...(handle ? { handle } : {}),
});

describe("mentionHandleForMember", () => {
  test("prefers canonical roster handle over display-name slug", () => {
    expect(
      mentionHandleForMember({
        actorId: "agent-actor",
        kind: "agent",
        displayName: "Jeannie Custom Name",
        handle: "genie",
        agentId: "agent-id",
        roomRole: "member",
      }),
    ).toBe("genie");
  });

  test("falls back to display-name slug for legacy rosters", () => {
    expect(
      mentionHandleForMember({
        actorId: "agent-actor",
        kind: "agent",
        displayName: "Jeannie Custom Name",
        agentId: "agent-id",
        roomRole: "member",
      }),
    ).toBe("jeannie_custom_name");
  });
});

describe("mention directive serialization", () => {
  test("offers the room audience before people and serializes it without a user UUID", () => {
    const items = mentionItemsForRoom([
      human("everyone-actor", "Everyone Person", "11111111-1111-4111-8111-111111111111", "everyone"),
      agent("everyone-agent", "Everyone Genie", "everyone"),
    ], undefined, true);
    expect(items[0]).toEqual({
      id: EVERYONE_MENTION_ITEM_ID,
      type: "user",
      label: "everyone",
      description: "Notify everyone in this room",
    });
    expect(items[1]?.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(items).toHaveLength(2);
    expect(mentionAtHandleFormatter.serialize(items[0])).toBe("@[everyone] ");
    expect(projectHumanMentionDirectives(mentionAtHandleFormatter.serialize(items[0])))
      .toEqual({ text: "@everyone ", mentionedHumanUserIds: [], mentionEveryone: true });
  });

  test("hides the room audience without manage_rooms while retaining a Human named everyone", () => {
    const items = mentionItemsForRoom([
      human("everyone-actor", "Everyone Person", "11111111-1111-4111-8111-111111111111", "everyone"),
      agent("everyone-agent", "Everyone Genie", "everyone"),
    ], undefined, false);

    expect(items).toEqual([{
      id: "11111111-1111-4111-8111-111111111111",
      type: "user",
      label: "everyone",
      description: "Everyone Person",
    }]);
  });
  test("Human picker items retain stable identity while sending readable handles", () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    const serialized = mentionAtHandleFormatter.serialize({
      id: userId,
      type: "user",
      label: "alice",
    });
    expect(projectHumanMentionDirectives(serialized)).toEqual({
      text: "@alice ",
      mentionedHumanUserIds: [userId],
    });
    expect(mentionAtHandleFormatter.parse("@alice manually")).toEqual([
      { kind: "text", text: "@alice manually" },
    ]);
  });

  test("retains a focused resource directive instead of exposing its entry id", () => {
    const serialized = mentionAtHandleFormatter.serialize({
      id: "347ad338-0f3e-4a4d-a864-9cc212eca1c4",
      type: "resource",
      label: "@budget.xlsx",
    });

    expect(serialized).toContain("resource:347ad338-0f3e-4a4d-a864-9cc212eca1c4");
    expect(projectResourceDirectives(`${serialized}then review it`)).toBe(
      "@budget.xlsx then review it",
    );
  });
});

describe("sortMembersForMentionPicker (recency rank)", () => {
  test("orders recent speakers before alphabetically-earlier silent members", () => {
    const members = [human("aaron", "Aaron"), human("alice", "Alice")];
    const spoke = new Map<string, number>([
      ["alice", 2_000],
      ["aaron", 1_000],
    ]);

    const recencyOrder = sortMembersForMentionPicker(members, spoke).map((m) => m.actorId);
    const alphaOrder = [...members]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((m) => m.actorId);

    expect(recencyOrder).toEqual(["alice", "aaron"]);
    expect(alphaOrder).toEqual(["aaron", "alice"]);
    expect(recencyOrder).not.toEqual(alphaOrder);
  });

  test("NO-OP guard: removing recency reverts to alpha-only order", () => {
    const members = [human("aaron", "Aaron"), human("alice", "Alice")];
    const spoke = new Map<string, number>([
      ["alice", 2_000],
      ["aaron", 1_000],
    ]);

    const withRecency = sortMembersForMentionPicker(members, spoke).map((m) => m.actorId);
    const withoutRecency = sortMembersForMentionPicker(members, new Map()).map((m) => m.actorId);

    expect(withRecency).toEqual(["alice", "aaron"]);
    expect(withoutRecency).toEqual(["aaron", "alice"]);
    expect(withRecency).not.toEqual(withoutRecency);
  });

  test("compareMentionMembersByRecency ranks newer timestamps first", () => {
    const a = human("aaron", "Aaron");
    const b = human("alice", "Alice");
    const spoke = new Map<string, number>([
      ["alice", 5_000],
      ["aaron", 1_000],
    ]);
    expect(compareMentionMembersByRecency(a, b, spoke)).toBeGreaterThan(0);
    expect(compareMentionMembersByRecency(b, a, spoke)).toBeLessThan(0);
  });
});

describe("buildLastSpokeAtMsFromThread", () => {
  test("maps human sourceUserId to actorId via roster", () => {
    const members = [human("alice-actor", "Alice", "user-alice")];
    const spoke = buildLastSpokeAtMsFromThread(
      [
        {
          role: "user",
          createdAt: "2026-06-01T12:00:00.000Z",
          metadata: { custom: { sourceUserId: "user-alice" } },
        },
      ],
      members,
    );
    expect(spoke.get("alice-actor")).toBe(Date.parse("2026-06-01T12:00:00.000Z"));
  });

  test("attributes assistant messages to room agent members", () => {
    const members = [agent("genie-actor", "Genie", "genie")];
    const spoke = buildLastSpokeAtMsFromThread(
      [{ role: "assistant", createdAt: 4_000 }],
      members,
    );
    expect(spoke.get("genie-actor")).toBe(4_000);
  });
});

describe("MentionSuggestionRow", () => {
  beforeAll(() => {
    for (const k of ["window", "document", "navigator", "HTMLElement"] as const) {
      priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
    }
    Object.assign(globalThis, {
      window: happyWindow,
      document: happyWindow.document,
      navigator: happyWindow.navigator,
      HTMLElement: happyWindow.HTMLElement,
    });
  });

  afterAll(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) {
        delete (globalThis as Record<string, unknown>)[key];
      } else {
        (globalThis as Record<string, unknown>)[key] = value;
      }
    }
  });

  test("renders UserAvatar and (H) for human members", () => {
    const member = human("u1", "Sender", "user-sender", "sender");
    const item: Unstable_TriggerItem = {
      id: "sender",
      type: "user",
      label: "Sender",
    };
    const html = renderToStaticMarkup(<MentionSuggestionRow item={item} member={member} />);
    expect(html).toContain("data-testid=\"user-avatar\"");
    expect(html).toContain("data-user-id=\"user-sender\"");
    expect(html).toContain("(H)");
  });

  test("renders the room audience choice with its complete purpose", () => {
    const html = renderToStaticMarkup(<MentionSuggestionRow item={{
      id: EVERYONE_MENTION_ITEM_ID,
      type: "user",
      label: "everyone",
      description: "Notify everyone in this room",
    }} member={undefined} />);
    expect(html).toContain("@everyone");
    expect(html).toContain("Notify everyone in this room");
    expect(html).not.toContain("data-testid=\"user-avatar\"");
  });

  test("renders agent initials glyph and (G) for agent members", () => {
    const member = agent("a1", "Genie", "genie");
    const item: Unstable_TriggerItem = {
      id: "genie",
      type: "agent",
      label: "Genie",
    };
    const html = renderToStaticMarkup(<MentionSuggestionRow item={item} member={member} />);
    expect(html).toContain("data-testid=\"mention-agent-avatar\"");
    expect(html).toContain(">G<");
    expect(html).toContain("(G)");
  });

  test("buildMemberByHandle indexes roster by mention handle", () => {
    const members = [human("u1", "Sender", "user-sender", "sender")];
    const byHandle = buildMemberByHandle(members);
    expect(byHandle.get("sender")?.actorId).toBe("u1");
  });
});

describe("Lexical composer accessibility", () => {
  test("labels the actual contenteditable rather than only its wrapper", () => {
    const root = happyWindow.document.createElement("div");
    const input = happyWindow.document.createElement("div");
    input.className = "aui-lexical-input";
    input.contentEditable = "true";
    root.append(input);

    applyLexicalComposerAccessibility(root as unknown as HTMLElement, "Message Moxie");

    expect(input.getAttribute("role")).toBe("textbox");
    expect(input.getAttribute("aria-label")).toBe("Message Moxie");
    expect(input.getAttribute("aria-multiline")).toBe("true");
  });
});
