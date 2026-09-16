/** D487 regression: manage_avatar applies only through the canonical library port. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createManageAvatarTool,
  setManageAvatarPhotoLibraryPort,
} from "../../src/tools/config/manage-avatar";

afterEach(() => setManageAvatarPhotoLibraryPort(null));

describe("manage_avatar canonical apply", () => {
  test("selects a preset with optimistic concurrency and no profile-store writer", async () => {
    const calls: unknown[] = [];
    setManageAvatarPhotoLibraryPort({
      current: async () => ({ selectionRevision: "4" }),
      generate: async () => {
        throw new Error("not used");
      },
      select: async (input) => {
        calls.push(input);
      },
    });
    const output = await createManageAvatarTool({
      ownerId: "owner-1",
      agentId: "agent-1",
    }).invoke({
      action: "apply",
      source: "preset",
      presetId: "avatar-12",
      expectedSelectionRevision: "4",
    });
    expect(output).toContain("avatar-12");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ownerId: "owner-1",
      agentId: "agent-1",
      expectedSelectionRevision: "4",
      target: { kind: "preset", presetId: "avatar-12" },
    });
  });
});
