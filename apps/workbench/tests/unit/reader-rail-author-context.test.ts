import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RoomMemberDto } from "@nautilo/types";
import { buildAuthorLabels } from "../../src/modes/rooms/shape/agent-author-label";

// repoRoot resolves to apps/workbench/ (mirrors active-room-single-shape.test.ts).
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(`${repoRoot}${rel}`, "utf8");

const slackSource = read("src/modes/rooms/shape/slack/SlackShapeRoom.tsx");
const shellSource = read("src/layouts/workbench-shell.tsx");
const conversationSource = read("src/components/conversation.tsx");

const human = (userId: string, name: string): RoomMemberDto => ({
  actorId: `actor-${userId}`,
  kind: "user",
  displayName: name,
  userId,
  roomRole: "member",
});

const agentMember = (actorId: string, name: string): RoomMemberDto => ({
  actorId,
  kind: "agent",
  displayName: name,
  agentId: actorId,
  roomRole: "member",
});

describe("D352 buildAuthorLabels", () => {
  test("maps human userId -> displayName", () => {
    const labels = buildAuthorLabels([human("u-1", "Alice"), human("u-2", "Bob")]);
    expect(labels.get("u-1")).toBe("Alice");
    expect(labels.get("u-2")).toBe("Bob");
  });

  test("excludes agents (they render via the assistant branch)", () => {
    const labels = buildAuthorLabels([agentMember("genie", "Genie"), human("u-1", "Alice")]);
    expect(labels.has("genie")).toBe(false);
    expect(labels.get("u-1")).toBe("Alice");
  });

  test("skips humans with empty/missing userId", () => {
    const noId = { actorId: "a", kind: "user", displayName: "Ghost", userId: "", roomRole: "member" } as RoomMemberDto;
    expect(buildAuthorLabels([noId]).size).toBe(0);
  });
});

describe("D352 (A) center + reader-rail mounts carry author/member context", () => {
  test("SlackShapeRoom wraps Conversation in RoomAuthorScope", () => {
    expect(slackSource).toContain('import { RoomAuthorScope }');
    expect(slackSource).toMatch(/<RoomAuthorScope members=\{members\}>[\s\S]*<Conversation \/>[\s\S]*<\/RoomAuthorScope>/);
  });

  test("SlackShapeRoom no longer hand-rolls the provider or label builder", () => {
    // The inline MessageAuthorProvider + label loop moved into RoomAuthorScope
    // (single shared builder). Their reappearance here = the split is back.
    expect(slackSource).not.toContain("MessageAuthorProvider");
    expect(slackSource).not.toContain("for (const m of members)");
  });

  test("workbench-shell wraps the reader-rail Conversation in RoomAuthorScope", () => {
    expect(shellSource).toContain('import { RoomAuthorScope }');
    expect(shellSource).toMatch(
      /<RoomAuthorScope members=\{activeRoomMembers\}>[\s\S]*?<Conversation chromeDensity="readerRail" \/>[\s\S]*?<\/RoomAuthorScope>/,
    );
  });
});

describe("D352 (B) Conversation self-sources author context when unwrapped", () => {
  test("Conversation gates on AuthorContext and falls back to a self-sourced scope", () => {
    expect(conversationSource).toContain("function SelfSourcedAuthorScope");
    expect(conversationSource).toContain("function ConversationBody");
    expect(conversationSource).toContain("useContext(AuthorContext) !== null");
    // The fallback sources the roster from the cached data hook, not context.
    expect(conversationSource).toContain("useRoomMembersData");
  });
});
