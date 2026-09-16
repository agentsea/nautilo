import { describe, expect, test } from "bun:test";

import {
  AgentPhotoLibraryConvergenceFixture,
  convergenceIds,
} from "../../../../packages/types/tests/fixtures/agent-photo-library-convergence";

describe("D487 desktop/mobile canonical convergence", () => {
  test("a mobile selection becomes desktop truth without replacing avatar_ref with entry metadata", () => {
    const server = new AgentPhotoLibraryConvergenceFixture();
    const desktop = server.createClient("desktop");
    const mobile = server.createClient("mobile");
    desktop.refresh();
    mobile.refresh();

    server.select("mobile", { kind: "entry", entryId: convergenceIds.mobileEntryId });
    const refreshed = desktop.refresh();

    expect(refreshed.current.current.avatarRef).toEqual({ kind: "uploaded", blobId: "blob-mobile" });
    expect(refreshed.current.current.entryId).toBe(convergenceIds.mobileEntryId);
    expect(refreshed.recent.find((entry) => entry.id === convergenceIds.mobileEntryId)).toMatchObject({
      isCurrent: true,
      source: "upload",
      origin: "mobile",
      media: { thumbnailUrl: expect.stringContaining("size=thumb") },
    });
    expect(refreshed.recent.filter((entry) => entry.isCurrent)).toHaveLength(1);
  });

  test("the shared contract covers presets, deletion, missing entries, and stable pagination", () => {
    const server = new AgentPhotoLibraryConvergenceFixture();
    const desktop = server.createClient("desktop").refresh();

    expect(desktop.presets.presets.map((preset) => preset.id)).toEqual(["avatar-01", "avatar-02"]);
    expect(desktop.deleted).toHaveLength(1);
    expect(desktop.deleted[0]).toMatchObject({ id: convergenceIds.deletedEntryId, isCurrent: false });
    expect(server.entry(convergenceIds.missingEntryId)).toBeNull();
    expect(desktop.recentPages).toHaveLength(2);
    expect(desktop.recent.map((entry) => entry.id)).toEqual([
      convergenceIds.mobileEntryId,
      convergenceIds.desktopEntryId,
      convergenceIds.currentEntryId,
    ]);
  });
});
