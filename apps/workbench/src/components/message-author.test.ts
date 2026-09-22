import { describe, expect, test } from "bun:test";

import {
  hasKnownHumanMessageAuthor,
  isCurrentMessageDeleteConfirmation,
  isOwnHumanMessage,
  resolveHumanMessageAuthorLabel,
} from "./message-author";

describe("human message authorship", () => {
  test("requires an exact persisted source id before treating a message as self", () => {
    expect(isOwnHumanMessage("viewer", "viewer")).toBe(true);
    expect(isOwnHumanMessage("peer", "viewer")).toBe(false);
    expect(isOwnHumanMessage(undefined, "viewer")).toBe(false);
    expect(isOwnHumanMessage("viewer", null)).toBe(false);
  });

  test("labels missing or unresolved authors without impersonating the viewer", () => {
    const labels = new Map([["peer", "Peer member"]]);
    expect(resolveHumanMessageAuthorLabel({
      sourceUserId: "viewer", viewerUserId: "viewer", labels,
    })).toBe("You");
    expect(resolveHumanMessageAuthorLabel({
      sourceUserId: "peer", viewerUserId: "viewer", labels,
    })).toBe("Peer member");
    expect(resolveHumanMessageAuthorLabel({
      sourceUserId: undefined, viewerUserId: "viewer", labels,
    })).toBe("Unknown sender");
    expect(resolveHumanMessageAuthorLabel({
      sourceUserId: "unknown", viewerUserId: "viewer", labels,
    })).toBe("Unknown sender");
  });

  test("relogin moves You to the newly verified Human without relabeling peers", () => {
    const labels = new Map([
      ["first-user", "First member"],
      ["second-user", "Second member"],
    ]);
    const messages = ["first-user", "second-user", undefined];
    const labelsFor = (viewerUserId: string | null) => messages.map((sourceUserId) =>
      resolveHumanMessageAuthorLabel({ sourceUserId, viewerUserId, labels }));
    const deleteOwnershipFor = (viewerUserId: string | null) => messages.map((sourceUserId) =>
      isOwnHumanMessage(sourceUserId, viewerUserId));

    expect(labelsFor(null)).toEqual(["First member", "Second member", "Unknown sender"]);
    expect(labelsFor("first-user")).toEqual(["You", "Second member", "Unknown sender"]);
    expect(deleteOwnershipFor("first-user")).toEqual([true, false, false]);
    expect(labelsFor(null)).toEqual(["First member", "Second member", "Unknown sender"]);
    expect(labelsFor("second-user")).toEqual(["First member", "You", "Unknown sender"]);
    expect(deleteOwnershipFor("second-user")).toEqual([false, true, false]);
  });

  test("missing Human identity cannot inherit moderation deletion authority", () => {
    expect(hasKnownHumanMessageAuthor("user", undefined)).toBe(false);
    expect(hasKnownHumanMessageAuthor("user", "peer")).toBe(true);
    expect(hasKnownHumanMessageAuthor("assistant", undefined)).toBe(true);
  });

  test("a deletion confirmation expires when viewer, Room, message, or authority changes", () => {
    const scope = JSON.stringify([3, "viewer", "actor", "room", 42]);
    expect(isCurrentMessageDeleteConfirmation(scope, scope, true)).toBe(true);
    expect(isCurrentMessageDeleteConfirmation(null, scope, true)).toBe(false);
    expect(isCurrentMessageDeleteConfirmation(scope, scope, false)).toBe(false);
    for (const changed of [
      [4, "viewer", "actor", "room", 42],
      [3, "other", "actor", "room", 42],
      [3, "viewer", "actor", "other-room", 42],
      [3, "viewer", "actor", "room", 43],
    ]) {
      expect(isCurrentMessageDeleteConfirmation(scope, JSON.stringify(changed), true)).toBe(false);
    }
  });
});
