import { describe, expect, test } from "bun:test";

import { pruneManifestEntries } from "../../electron/local-file-history/retention";
import type { LocalRevisionEntry } from "../../electron/local-file-history/types";

function entry(
  id: string,
  overrides: Partial<LocalRevisionEntry> = {},
): LocalRevisionEntry {
  return {
    id,
    ownerId: "owner",
    agentId: "agent",
    turnId: "turn",
    requestedPath: "/tmp/file.txt",
    canonicalPath: "/tmp/file.txt",
    operation: "write",
    createdAt: new Date().toISOString(),
    preState: { kind: "missing" },
    postState: { kind: "bytes", sha256: "a", size: 1 },
    pinned: false,
    payloadBytes: 1,
    ...overrides,
  };
}

describe("retention pruneManifestEntries", () => {
  test("enforces per-path count cap", () => {
    const entries = ["a", "b", "c", "d", "e", "f"].map((id, i) =>
      entry(id, {
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
    const prune = pruneManifestEntries(entries, {
      maxEntriesPerPath: 3,
      maxAgeMs: 1_000_000_000,
      maxTotalBytes: 1_000_000,
    });
    expect(prune.removedIds.length).toBe(3);
    expect(prune.removedIds).toContain("d");
    expect(prune.removedIds).toContain("e");
    expect(prune.removedIds).toContain("f");
  });

  test("prunes dependent redo chain when parent is evicted", () => {
    const parent = entry("parent", {
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const child = entry("child", {
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      restoreFromRevisionId: "parent",
    });
    const prune = pruneManifestEntries([parent, child], {
      maxEntriesPerPath: 1,
      maxAgeMs: 1_000_000_000,
      maxTotalBytes: 1_000_000,
    });
    expect(prune.removedIds.sort()).toEqual(["child", "parent"]);
  });

  test("keeps pinned entries beyond count cap", () => {
    const pinned = entry("pinned", {
      pinned: true,
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const older = entry("older", {
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const newest = entry("newest", {
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const prune = pruneManifestEntries([pinned, older, newest], {
      maxEntriesPerPath: 1,
      maxAgeMs: 1_000_000_000,
      maxTotalBytes: 1_000_000,
    });
    expect(prune.removedIds).toEqual(["older"]);
  });
});
