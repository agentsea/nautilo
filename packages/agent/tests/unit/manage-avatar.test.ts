/** D487 — canonical manage_avatar port and show → confirm → apply contract. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  clampAvatarCount,
  createManageAvatarTool,
  setManageAvatarPhotoLibraryPort,
  type ManageAvatarPhotoLibraryPort,
} from "../../src/tools/config/manage-avatar";

const entryId = "11111111-1111-4111-8111-111111111111";

function port(
  overrides: Partial<ManageAvatarPhotoLibraryPort> = {},
): ManageAvatarPhotoLibraryPort {
  return {
    current: async () => ({ selectionRevision: "7" }),
    generate: async () => ({
      selectionRevision: "7",
      model: "gpt-image-2",
      provider: "openai",
      candidates: [
        {
          entryId,
          thumbnailUrl: `/api/profile/agent-photo-library/entries/${entryId}/media?size=thumb`,
          fullUrl: `/api/profile/agent-photo-library/entries/${entryId}/media?size=full`,
        },
      ],
    }),
    select: async () => undefined,
    ...overrides,
  };
}

afterEach(() => setManageAvatarPhotoLibraryPort(null));

describe("manage_avatar schema and helpers", () => {
  test("exposes the canonical entry/revision schema and rejects legacy blob ids", () => {
    const tool = createManageAvatarTool({
      ownerId: "user-A",
      agentId: "agent-A",
    });
    const schema = (
      tool as unknown as {
        schema: { safeParse(value: unknown): { success: boolean } };
      }
    ).schema;
    expect(tool.name).toBe("manage_avatar");
    expect(
      schema.safeParse({
        action: "preview",
        source: "generate",
        prompt: "a fox",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        action: "apply",
        entryId,
        expectedSelectionRevision: "7",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ action: "apply", blobId: "legacy" }).success,
    ).toBe(false);
    expect(schema.safeParse({ action: "delete" }).success).toBe(false);
    expect(
      schema.safeParse({ action: "preview", prompt: "x", count: 9 }).success,
    ).toBe(false);
  });

  test("clamps generation count into 1..4", () => {
    expect(clampAvatarCount(undefined)).toBe(2);
    expect(clampAvatarCount(0)).toBe(1);
    expect(clampAvatarCount(2.9)).toBe(2);
    expect(clampAvatarCount(9)).toBe(4);
    expect(clampAvatarCount(Number.NaN)).toBe(2);
  });
});

describe("manage_avatar canonical behavior", () => {
  test("fails closed without turn authority or an installed server port", async () => {
    expect(
      await createManageAvatarTool({ ownerId: "user-A" }).invoke({
        action: "preview",
        source: "preset",
        presetId: "avatar-12",
      }),
    ).toContain("no Agent authority");
    expect(
      await createManageAvatarTool({
        ownerId: "user-A",
        agentId: "agent-A",
      }).invoke({ action: "preview", source: "preset", presetId: "avatar-12" }),
    ).toContain("photo library is unavailable");
  });

  test("preset preview reads the current revision and does not select", async () => {
    let selects = 0;
    setManageAvatarPhotoLibraryPort(
      port({
        select: async () => {
          selects += 1;
        },
      }),
    );
    const output = await createManageAvatarTool({
      ownerId: "user-A",
      agentId: "agent-A",
    }).invoke({ action: "preview", source: "preset", presetId: "avatar-12" });
    expect(JSON.parse(output)).toEqual({
      action: "preview",
      source: "preset",
      selectionRevision: "7",
      candidates: [{ presetId: "avatar-12" }],
    });
    expect(selects).toBe(0);
  });

  test("generated preview delegates creation and returns owned entry media, never blob ids", async () => {
    const calls: unknown[] = [];
    setManageAvatarPhotoLibraryPort(
      port({
        generate: async (input) => {
          calls.push(input);
          return await port().generate(input);
        },
      }),
    );
    const output = await createManageAvatarTool({
      ownerId: "user-A",
      agentId: "agent-A",
    }).invoke({
      action: "preview",
      source: "generate",
      prompt: "a blue fox",
      count: 1,
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ownerId: "user-A",
      agentId: "agent-A",
      prompt: "a blue fox",
      count: 1,
    });
    expect(parsed["selectionRevision"]).toBe("7");
    expect(parsed["candidates"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ entryId })]),
    );
    expect(output).not.toContain("blobId");
  });

  test("apply requires preview revision and delegates exact entry target", async () => {
    const calls: unknown[] = [];
    setManageAvatarPhotoLibraryPort(
      port({
        select: async (input) => {
          calls.push(input);
        },
      }),
    );
    const tool = createManageAvatarTool({
      ownerId: "user-A",
      agentId: "agent-A",
    });
    expect(await tool.invoke({ action: "apply", entryId })).toContain(
      "preview again",
    );
    const output = await tool.invoke({
      action: "apply",
      entryId,
      expectedSelectionRevision: "7",
    });
    expect(output).toContain("owned photo library");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      ownerId: "user-A",
      agentId: "agent-A",
      expectedSelectionRevision: "7",
      target: { kind: "entry", entryId },
    });
  });

  test("invalid presets never reach selection", async () => {
    let selects = 0;
    setManageAvatarPhotoLibraryPort(
      port({
        select: async () => {
          selects += 1;
        },
      }),
    );
    const tool = createManageAvatarTool({
      ownerId: "user-A",
      agentId: "agent-A",
    });
    expect(
      await tool.invoke({
        action: "preview",
        source: "preset",
        presetId: "wrong",
      }),
    ).toContain("invalid preset");
    expect(selects).toBe(0);
  });
});
