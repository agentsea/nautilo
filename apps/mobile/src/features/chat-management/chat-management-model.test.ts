import { describe, expect, test } from "bun:test";

import { chatManagementActions, validateChatLabel } from "./chat-management-model";

const baseRoom = {
  type: "private",
  kind: "private" as const,
  roster: [{ actorId: "viewer", kind: "user" as const, displayName: "Viewer" }],
};

describe("D529 chat management model", () => {
  test("derives only implemented and applicable actions", () => {
    expect(chatManagementActions(baseRoom, {
      canManage: true,
      canLeave: true,
      isArchived: false,
      viewerActorId: "viewer",
    })).toEqual(["rename", "archive", "leave"]);
    expect(chatManagementActions({ ...baseRoom, type: "group" }, {
      canManage: true,
      canLeave: true,
      isArchived: true,
      viewerActorId: "viewer",
    })).toEqual(["unarchive", "leave"]);
    expect(chatManagementActions(baseRoom, {
      canManage: false,
      canLeave: true,
      isArchived: false,
      viewerActorId: "viewer",
    })).toEqual(["leave"]);
  });

  test("does not invent delete, leave direct chats, or leave inherited thread membership", () => {
    expect(chatManagementActions(baseRoom, {
      canManage: false,
      canLeave: false,
      isArchived: false,
      viewerActorId: "viewer",
    })).toEqual([]);
    expect(chatManagementActions({ ...baseRoom, kind: "group" }, {
      canManage: false,
      canLeave: true,
      isArchived: false,
      viewerActorId: "viewer",
    })).toEqual(["leave"]);
    expect(chatManagementActions({ ...baseRoom, kind: "subthread" }, {
      canManage: true,
      canLeave: true,
      isArchived: false,
      viewerActorId: "viewer",
    })).toEqual(["rename", "archive"]);
  });

  test("uses the canonical trimmed non-empty 80-character label contract", () => {
    expect(validateChatLabel("  Launch plan  ")).toEqual({ ok: true, label: "Launch plan" });
    expect(validateChatLabel("   ")).toMatchObject({ ok: false });
    expect(validateChatLabel("x".repeat(81))).toMatchObject({ ok: false });
  });
});
