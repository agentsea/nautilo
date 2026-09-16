import { describe, expect, test } from "bun:test";

import {
  AgentPhotoLibraryConvergenceFixture,
  convergenceIds,
} from "../../../../../packages/types/tests/fixtures/agent-photo-library-convergence";

describe("D487 mobile/desktop canonical convergence", () => {
  test("a mobile photo selection refreshes one coherent current, recent, and presets snapshot", () => {
    const server = new AgentPhotoLibraryConvergenceFixture();
    const mobile = server.createClient("mobile");
    mobile.refresh();

    server.select("mobile", { kind: "entry", entryId: convergenceIds.mobileEntryId });
    const refreshed = mobile.refresh();

    expect(refreshed.current.current).toMatchObject({
      avatarRef: { kind: "uploaded", blobId: "blob-mobile" },
      entryId: convergenceIds.mobileEntryId,
    });
    expect(refreshed.recent.find((entry) => entry.id === convergenceIds.mobileEntryId)).toMatchObject({
      isCurrent: true,
      source: "upload",
      origin: "mobile",
    });
    expect(refreshed.presets.presets.map((preset) => preset.id)).toEqual(["avatar-01", "avatar-02"]);
  });

  test("a desktop selection becomes mobile truth through current plus list refresh", () => {
    const server = new AgentPhotoLibraryConvergenceFixture();
    const desktop = server.createClient("desktop");
    const mobile = server.createClient("mobile");
    desktop.refresh();
    mobile.refresh();

    server.select("desktop", { kind: "entry", entryId: convergenceIds.desktopEntryId });
    const refreshed = mobile.refresh();

    expect(refreshed.current.current.avatarRef).toEqual({ kind: "generated", blobId: "blob-desktop" });
    expect(refreshed.current.current.entryId).toBe(convergenceIds.desktopEntryId);
    expect(refreshed.recent.find((entry) => entry.id === convergenceIds.desktopEntryId)).toMatchObject({
      isCurrent: true,
      source: "generation",
      origin: "workbench",
    });
    expect(refreshed.recent.find((entry) => entry.id === convergenceIds.currentEntryId)?.isCurrent).toBe(false);
  });

  test("a deferred old refresh cannot resurrect the pre-race selection", () => {
    const server = new AgentPhotoLibraryConvergenceFixture();
    const mobile = server.createClient("mobile");
    const stale = mobile.beginRefresh();
    expect(stale.snapshot.current.current.entryId).toBe(convergenceIds.currentEntryId);

    server.select("desktop", { kind: "preset", presetId: "avatar-02" });
    const winner = mobile.refresh();
    expect(winner.current.current.avatarRef).toEqual({ kind: "preset", id: "avatar-02" });
    expect(winner.current.current.entryId).toBeNull();
    expect(winner.recent.some((entry) => entry.isCurrent)).toBe(false);

    expect(stale.commit()).toBe(false);
    expect(mobile.state?.current.current.avatarRef).toEqual({ kind: "preset", id: "avatar-02" });
    expect(mobile.state?.current.current.entryId).toBeNull();
  });
});
