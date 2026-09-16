import { describe, expect, test, beforeEach } from "bun:test";
import type { DocumentPatchEvent } from "@nautilo/types";
import {
  appendWorkspaceArtifactPatchEvent,
  clearWorkspaceArtifactPatchCacheForTests,
  getWorkspaceArtifactPatchEventsSince,
} from "../../src/lib/workspace-artifact-patch-cache";

function sampleEvent(revision: number, patchId: string): DocumentPatchEvent {
  return {
    type: "document.patch.applied",
    target: {
      kind: "artifact",
      artifactInternalId: "art-1",
      path: "notes/a.md",
    },
    patchId,
    revision,
    sha256: `sha-${revision}`,
    previousRevision: revision - 1,
    previousSha256: `sha-${revision - 1}`,
    patch: { kind: "anchored_text", oldString: "a", newString: "b" },
    author: { kind: "human", displayName: "Tester" },
  };
}

describe("workspace-artifact-patch-cache", () => {
  beforeEach(() => {
    clearWorkspaceArtifactPatchCacheForTests();
  });

  test("returns contiguous events since revision", () => {
    appendWorkspaceArtifactPatchEvent("art-1", sampleEvent(1, "p1"));
    appendWorkspaceArtifactPatchEvent("art-1", sampleEvent(2, "p2"));
    const out = getWorkspaceArtifactPatchEventsSince("art-1", { sinceRevision: 1 });
    expect(out).toEqual({
      ok: true,
      events: [sampleEvent(2, "p2")],
    });
  });

  test("serves first contiguous event even when baseline revision is absent", () => {
    appendWorkspaceArtifactPatchEvent("art-1", sampleEvent(2, "p2"));
    const out = getWorkspaceArtifactPatchEventsSince("art-1", { sinceRevision: 1 });
    expect(out).toEqual({ ok: true, events: [sampleEvent(2, "p2")] });
  });

  test("cache miss when the first needed revision is absent", () => {
    appendWorkspaceArtifactPatchEvent("art-1", sampleEvent(3, "p3"));
    const out = getWorkspaceArtifactPatchEventsSince("art-1", { sinceRevision: 1 });
    expect(out).toEqual({ ok: false, reason: "cache_miss" });
  });

  test("sincePatchId returns following events", () => {
    appendWorkspaceArtifactPatchEvent("art-1", sampleEvent(1, "p1"));
    appendWorkspaceArtifactPatchEvent("art-1", sampleEvent(2, "p2"));
    const out = getWorkspaceArtifactPatchEventsSince("art-1", { sincePatchId: "p1" });
    expect(out).toEqual({ ok: true, events: [sampleEvent(2, "p2")] });
  });
});
