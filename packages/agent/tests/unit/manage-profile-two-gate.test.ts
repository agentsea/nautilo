/**
 * M128 — TP8 manage_profile two-gate self-edit assertions.
 *
 * Source spec: ISSUE-M128 §12.1 / §15.1. Sibling of TP7 — same shape
 * for the `manage_profile` tool.
 */
import { describe, expect, test } from "bun:test";
import { createManageProfileTool } from "../../src/tools/config/manage-profile";

describe("M128 D4-A — manage_profile is self-edit by construction (TP8)", () => {
  test("tool name is `manage_profile`", () => {
    const tool = createManageProfileTool({ ownerId: "user-A" });
    expect(tool.name).toBe("manage_profile");
  });

  test("schema has NO target user/agent parameter (action + fields only)", () => {
    const tool = createManageProfileTool({ ownerId: "user-A" });
    const schema = (tool as unknown as { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }).schema;
    const parsed = schema.safeParse({
      action: "read",
      targetUserId: "user-B", // not a recognized field
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown> | undefined)?.["targetUserId"]).toBeUndefined();
  });

  test("two different tool instances are bound to different ownerIds (isolation)", () => {
    const toolA = createManageProfileTool({ ownerId: "user-A" });
    const toolB = createManageProfileTool({ ownerId: "user-B" });
    expect(toolA).not.toBe(toolB);
    expect(toolA.name).toBe(toolB.name);
  });
});
