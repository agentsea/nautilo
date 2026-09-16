import { beforeEach, describe, expect, test } from "bun:test";
import type { DocumentPatchEvent } from "@nautilo/types";
import { forwardWorkspaceArtifactBusEvent } from "../../src/lib/workspace-artifact-bus-event";
import {
  clearWorkspaceArtifactPatchCacheForTests,
  getWorkspaceArtifactPatchEventsSince,
} from "../../src/lib/workspace-artifact-patch-cache";

function samplePatchEvent(revision: number, patchId: string): DocumentPatchEvent {
  return {
    type: "document.patch.applied",
    target: {
      kind: "artifact",
      artifactInternalId: "row-1",
      path: "notes/a.md",
    },
    patchId,
    revision,
    sha256: `sha-${revision}`,
    previousRevision: revision - 1,
    previousSha256: `sha-${revision - 1}`,
    patch: { kind: "anchored_text", oldString: "a", newString: "b" },
    author: { kind: "agent", displayName: "agent-1" },
  };
}

describe("forwardWorkspaceArtifactBusEvent", () => {
  beforeEach(() => {
    clearWorkspaceArtifactPatchCacheForTests();
  });

  test("caches document.patch.applied and forwards to emit", () => {
    const forwarded: unknown[] = [];
    const event = samplePatchEvent(2, "p2");
    forwardWorkspaceArtifactBusEvent(event, (ev) => {
      forwarded.push(ev);
    });

    expect(forwarded).toEqual([event]);
    expect(getWorkspaceArtifactPatchEventsSince("row-1", { sinceRevision: 1 })).toEqual({
      ok: true,
      events: [event],
    });
  });

  test("forwards invalidation events without caching", () => {
    const forwarded: unknown[] = [];
    const changed = {
      type: "workspace.artifact.changed" as const,
      id: "row-1",
      artifactId: "artifact-1",
      path: "notes/a.md",
    };
    forwardWorkspaceArtifactBusEvent(changed, (ev) => {
      forwarded.push(ev);
    });

    expect(forwarded).toEqual([changed]);
    expect(getWorkspaceArtifactPatchEventsSince("row-1", { sinceRevision: 0 })).toEqual({
      ok: false,
      reason: "cache_miss",
    });
  });

  test("forwards reloadRequired on changed invalidation", () => {
    const forwarded: unknown[] = [];
    const changed = {
      type: "workspace.artifact.changed" as const,
      id: "row-1",
      artifactId: "artifact-1",
      path: "notes/a.md",
      reloadRequired: true,
    };
    forwardWorkspaceArtifactBusEvent(changed, (ev) => {
      forwarded.push(ev);
    });

    expect(forwarded).toEqual([changed]);
  });
});
