import { describe, expect, test } from "bun:test";
import {
  projectExactArtifactCreationRoom,
  projectExactArtifactFeedAuthor,
} from "../../src/event-feed/artifact-identities";

describe("Artifact feed identity proof", () => {
  test("attributes only an exact-one Actor match", () => {
    const actor = { actorId: "actor-a", userId: "user-a" };

    expect(projectExactArtifactFeedAuthor([actor], "human")).toEqual({
      ...actor,
      kind: "human",
    });
    expect(projectExactArtifactFeedAuthor([], "human")).toBeNull();
    expect(projectExactArtifactFeedAuthor([
      actor,
      { actorId: "actor-b", userId: "user-a" },
    ], "human")).toBeNull();
  });

  test("uses only an exact-one eligible top-level Room", () => {
    expect(projectExactArtifactCreationRoom([{ id: "room-a", kind: "private" }])).toBe("room-a");
    expect(projectExactArtifactCreationRoom([])).toBeNull();
    expect(projectExactArtifactCreationRoom([
      { id: "room-a", kind: "private" },
      { id: "room-b", kind: "group" },
    ])).toBeNull();
    expect(projectExactArtifactCreationRoom([{ id: "access", kind: "access" }])).toBeNull();
    expect(projectExactArtifactCreationRoom([{ id: "task", kind: "task" }])).toBeNull();
  });
});
