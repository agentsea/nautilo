import { describe, expect, test } from "bun:test";
import {
  artifactDropTargetPath,
  artifactParentPath,
  collectDescendantArtifacts,
  collectFolderDescendantArtifacts,
  countFolderChildren,
  detectRebaseCollisions,
  isCyclicFolderDrop,
  isSameFolderNoOp,
  planFolderRebase,
  planMoveToDir,
  parseArtifactTreeMoveFromDataTransfer,
  rebaseArtifactPath,
  resolveArtifactMoveRowId,
} from "../../src/components/browser-column/artifact-move";
import { buildFolderMarkerPath } from "../../src/components/browser-column/artifact-tree";

const artifacts = [
  { id: "m1", path: "drafts/.nautilo-keep.md" },
  { id: "f1", path: "drafts/note.md" },
  { id: "f2", path: "drafts/nested/.nautilo-keep.md" },
  { id: "f3", path: "drafts/nested/page.md" },
  { id: "r1", path: "readme.md" },
];

describe("artifactDropTargetPath", () => {
  test("moves leaf into nested folder", () => {
    expect(artifactDropTargetPath("readme.md", "drafts")).toBe("drafts/readme.md");
  });

  test("move-to-root strips parent prefix", () => {
    expect(artifactDropTargetPath("drafts/note.md", "")).toBe("note.md");
  });
});

describe("isSameFolderNoOp", () => {
  test("detects item already in target folder", () => {
    expect(isSameFolderNoOp("drafts/note.md", "drafts")).toBe(true);
    expect(isSameFolderNoOp("readme.md", "")).toBe(true);
    expect(isSameFolderNoOp("readme.md", "drafts")).toBe(false);
  });
});

describe("artifactParentPath", () => {
  test("returns empty string for root-level paths", () => {
    expect(artifactParentPath("foo.md")).toBe("");
    expect(artifactParentPath("drafts/note.md")).toBe("drafts");
  });
});

describe("rebaseArtifactPath", () => {
  test("rebases nested file under folder prefix", () => {
    expect(rebaseArtifactPath("a/b/c.txt", "a/b", "x/y")).toBe("x/y/c.txt");
  });

  test("rebases folder marker", () => {
    const oldPrefix = "drafts";
    const newPrefix = "archive";
    expect(rebaseArtifactPath(buildFolderMarkerPath(oldPrefix), oldPrefix, newPrefix)).toBe(
      buildFolderMarkerPath(newPrefix),
    );
  });

  test("rebases folder prefix itself", () => {
    expect(rebaseArtifactPath("a/b", "a/b", "z")).toBe("z");
  });
});

describe("collectDescendantArtifacts", () => {
  test("includes marker and all nested paths", () => {
    const collected = collectDescendantArtifacts(artifacts, "drafts");
    expect(collected.map((a) => a.path).sort()).toEqual(
      [
        "drafts/.nautilo-keep.md",
        "drafts/nested/.nautilo-keep.md",
        "drafts/nested/page.md",
        "drafts/note.md",
      ].sort(),
    );
  });
});

describe("collectFolderDescendantArtifacts", () => {
  test("does not include a file colliding with the virtual folder path", () => {
    const collision = [...artifacts, { id: "file-at-folder", path: "drafts" }];
    const collected = collectFolderDescendantArtifacts(collision, "drafts");
    expect(collected.some((artifact) => artifact.id === "file-at-folder")).toBe(false);
    expect(collected.some((artifact) => artifact.id === "f1")).toBe(true);
  });
});

describe("countFolderChildren", () => {
  test("excludes marker from child count", () => {
    expect(countFolderChildren(artifacts, "drafts")).toBe(2);
  });
});

describe("planFolderRebase", () => {
  test("plans ops for every descendant including marker", () => {
    const ops = planFolderRebase(artifacts, "drafts", "archive");
    expect(ops).toHaveLength(4);
    expect(ops.find((o) => o.oldPath === "drafts/note.md")?.newPath).toBe("archive/note.md");
    expect(ops.find((o) => o.oldPath === buildFolderMarkerPath("drafts"))?.newPath).toBe(
      buildFolderMarkerPath("archive"),
    );
  });
});

describe("isCyclicFolderDrop", () => {
  test("rejects self and descendant targets", () => {
    expect(isCyclicFolderDrop("drafts", "drafts")).toBe(true);
    expect(isCyclicFolderDrop("drafts", "drafts/nested")).toBe(true);
    expect(isCyclicFolderDrop("drafts", "archive")).toBe(false);
  });
});

describe("detectRebaseCollisions", () => {
  test("flags a destination already occupied by a non-moving artifact", () => {
    // Moving readme.md into drafts/ collides with... nothing here, so seed one.
    const withClash = [...artifacts, { id: "c1", path: "archive/note.md" }];
    const ops = planFolderRebase(withClash, "drafts", "archive");
    // archive/note.md already exists and is NOT part of the moved set → collision.
    expect(detectRebaseCollisions(withClash, ops)).toContain("archive/note.md");
  });

  test("no collision when destinations are all free", () => {
    const ops = planFolderRebase(artifacts, "drafts", "archive");
    expect(detectRebaseCollisions(artifacts, ops)).toEqual([]);
  });

  test("a destination occupied only by a co-moving row is not a collision", () => {
    // Rename in place-ish: every newPath's occupant is itself moving away.
    const set = [
      { id: "a", path: "x/a.md" },
      { id: "b", path: "x/b.md" },
    ];
    const ops = [
      { rowId: "a", oldPath: "x/a.md", newPath: "x/b.md" },
      { rowId: "b", oldPath: "x/b.md", newPath: "x/c.md" },
    ];
    // x/b.md is occupied, but row "b" (its occupant) is moving away → not flagged.
    expect(detectRebaseCollisions(set, ops)).toEqual([]);
  });
});

describe("planMoveToDir (multi-select move)", () => {
  test("moves a mix of files and folders into a target dir, deduped by row", () => {
    // Select the file drafts/note.md AND the folder drafts/nested; move both to root.
    const ops = planMoveToDir(artifacts, ["drafts/note.md", "drafts/nested"], "");
    const byOld = new Map(ops.map((o) => [o.oldPath, o.newPath]));
    expect(byOld.get("drafts/note.md")).toBe("note.md");
    expect(byOld.get("drafts/nested/page.md")).toBe("nested/page.md");
    expect(byOld.get("drafts/nested/.nautilo-keep.md")).toBe("nested/.nautilo-keep.md");
    // No duplicate rowIds.
    expect(new Set(ops.map((o) => o.rowId)).size).toBe(ops.length);
  });

  test("skips items already living in the target dir", () => {
    const ops = planMoveToDir(artifacts, ["drafts/note.md"], "drafts");
    expect(ops).toEqual([]);
  });

  test("moves only the selected internal ID when paths collide", () => {
    const samePath = [
      { id: "first", path: "drafts/report.md" },
      { id: "second", path: "drafts/report.md" },
    ];
    const ops = planMoveToDir(
      samePath,
      [{ path: "drafts/report.md", rowId: "second", isDir: false }],
      "archive",
    );
    expect(ops).toEqual([
      { rowId: "second", oldPath: "drafts/report.md", newPath: "archive/report.md" },
    ]);
  });

  test("refuses a path-only file source when multiple internal IDs share that path", () => {
    const samePath = [
      { id: "first", path: "drafts/report.md" },
      { id: "second", path: "drafts/report.md" },
    ];
    expect(
      planMoveToDir(
        samePath,
        [{ path: "drafts/report.md", isDir: false }],
        "archive",
      ),
    ).toEqual([]);
  });

  test("rejects the whole plan when one selected source is ambiguous", () => {
    const mixed = [
      { id: "valid", path: "drafts/unique.md" },
      { id: "first", path: "drafts/report.md" },
      { id: "second", path: "drafts/report.md" },
    ];
    expect(
      planMoveToDir(
        mixed,
        [
          { path: "drafts/unique.md", rowId: "valid", isDir: false },
          { path: "drafts/report.md", isDir: false },
        ],
        "archive",
      ),
    ).toEqual([]);
  });

  test("rejects a supplied row ID whose current path does not match", () => {
    expect(
      planMoveToDir(
        [{ id: "selected", path: "current/report.md" }],
        [{ path: "stale/report.md", rowId: "selected", isDir: false }],
        "archive",
      ),
    ).toEqual([]);
  });
});

describe("artifact move identity validation", () => {
  test("resolves legacy path-only moves only when the path identifies one row", () => {
    const samePath = [
      { id: "first", path: "report.md" },
      { id: "second", path: "report.md" },
    ];
    expect(resolveArtifactMoveRowId(samePath, "report.md")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
    expect(resolveArtifactMoveRowId([{ id: "only", path: "report.md" }], "report.md")).toEqual({
      ok: true,
      rowId: "only",
    });
    expect(resolveArtifactMoveRowId(samePath, "report.md", "missing")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      resolveArtifactMoveRowId(
        [
          { id: "selected", path: "current/report.md" },
          { id: "other", path: "stale/report.md" },
        ],
        "stale/report.md",
        "selected",
      ),
    ).toEqual({ ok: false, reason: "missing" });
  });

  test("rejects malformed identity-preserving drag items", () => {
    const dataTransfer = {
      types: ["application/x-nautilo-artifact-tree-move"],
      getData: () =>
        JSON.stringify({
          kind: "artifact",
          path: "report.md",
          isDir: false,
          items: [{ path: "report.md", rowId: 42, isDir: false }],
        }),
    } as unknown as DataTransfer;
    expect(parseArtifactTreeMoveFromDataTransfer(dataTransfer)).toBeNull();
  });
});
