import { describe, expect, test } from "bun:test";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import {
  buildFolderMarkerPath,
  buildTreeFromArtifacts,
  flattenTreeForRendering,
  isFolderMarkerPath,
} from "../../src/components/browser-column/artifact-tree";

function dto(partial: Partial<ArtifactDto> & Pick<ArtifactDto, "id" | "artifactId" | "path">): ArtifactDto {
  return {
    mimeType: "text/plain",
    size: 0,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    namespaceIds: [],
    canWrite: true,
    ...partial,
  };
}

describe("isFolderMarkerPath", () => {
  test("matches root and nested marker paths only", () => {
    expect(isFolderMarkerPath(".nautilo-keep.md")).toBe(true);
    expect(isFolderMarkerPath("foo/.nautilo-keep.md")).toBe(true);
    expect(isFolderMarkerPath("a/b/c/.nautilo-keep.md")).toBe(true);
    expect(isFolderMarkerPath("notes.md")).toBe(false);
    expect(isFolderMarkerPath("foo/notes.md")).toBe(false);
    expect(isFolderMarkerPath("foo/.nautilo-keep")).toBe(false);
  });
});

describe("buildFolderMarkerPath", () => {
  test("appends marker basename under folder path", () => {
    expect(buildFolderMarkerPath("projects")).toBe("projects/.nautilo-keep.md");
    expect(buildFolderMarkerPath("a/b")).toBe("a/b/.nautilo-keep.md");
  });
});

describe("buildTreeFromArtifacts", () => {
  test("single file at depth one is one root leaf", () => {
    const tree = buildTreeFromArtifacts([dto({ id: "1", artifactId: "a1", path: "foo.png" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].isDir).toBe(false);
    expect(tree[0].name).toBe("foo.png");
    expect(tree[0].artifactId).toBe("a1");
  });

  test("nested paths share intermediate directories", () => {
    const tree = buildTreeFromArtifacts([
      dto({ id: "1", artifactId: "x", path: "a/b/c.png" }),
      dto({ id: "2", artifactId: "y", path: "a/d/e.png" }),
    ]);
    expect(tree).toHaveLength(1);
    const a = tree[0];
    expect(a.isDir).toBe(true);
    expect(a.name).toBe("a");
    const names = (a.children ?? []).map((c) => c.name).sort();
    expect(names).toEqual(["b", "d"]);
  });

  test("directory-first sort under a parent", () => {
    const tree = buildTreeFromArtifacts([
      dto({ id: "1", artifactId: "f", path: "a/file.txt" }),
      dto({ id: "2", artifactId: "s", path: "a/dir/sub.txt" }),
    ]);
    const a = tree[0];
    expect(a.children?.map((c) => c.name)).toEqual(["dir", "file.txt"]);
  });

  test("empty input yields empty forest", () => {
    expect(buildTreeFromArtifacts([])).toEqual([]);
  });

  test("deep nesting preserves path and leaf metadata", () => {
    const tree = buildTreeFromArtifacts([
      dto({
        id: "id5",
        artifactId: "aid5",
        path: "l1/l2/l3/l4/file.bin",
        mimeType: "application/octet-stream",
        size: 99,
      }),
    ]);
    const walk = (n: (typeof tree)[0], depth: number): number => {
      if (!n.isDir) return depth;
      const c = n.children?.[0];
      return c ? walk(c, depth + 1) : depth;
    };
    expect(walk(tree[0], 1)).toBe(5);
    const leaf = tree[0].children![0].children![0].children![0].children![0];
    expect(leaf.isDir).toBe(false);
    expect(leaf.path).toBe("l1/l2/l3/l4/file.bin");
    expect(leaf.mimeType).toBe("application/octet-stream");
    expect(leaf.size).toBe(99);
    expect(leaf.artifactId).toBe("aid5");
    expect(leaf.rowId).toBe("id5");
  });

  test("mimeType and size propagate to leaves", () => {
    const tree = buildTreeFromArtifacts([
      dto({
        id: "r",
        artifactId: "s",
        path: "x/y.z",
        mimeType: "image/png",
        size: 42,
      }),
    ]);
    const leaf = tree[0].children![0];
    expect(leaf.mimeType).toBe("image/png");
    expect(leaf.size).toBe(42);
  });

  test("preserves distinct artifacts that share the same logical path", () => {
    const tree = buildTreeFromArtifacts([
      dto({ id: "same-prefix-alpha", artifactId: "artifact-alpha", path: "report.md" }),
      dto({ id: "same-prefix-bravo", artifactId: "artifact-bravo", path: "report.md" }),
    ]);

    expect(tree.map((node) => node.rowId).sort()).toEqual([
      "same-prefix-alpha",
      "same-prefix-bravo",
    ]);
    expect(new Set(tree.map((node) => node.key)).size).toBe(2);
    expect(tree.every((node) => node.path === "report.md")).toBe(true);
    expect(tree.map((node) => node.label)).toEqual([
      "report.md · same-prefix-a",
      "report.md · same-prefix-b",
    ]);
  });

  test("preserves a file whose path also names a virtual folder", () => {
    const tree = buildTreeFromArtifacts([
      dto({ id: "file-foo", artifactId: "artifact-foo", path: "foo" }),
      dto({ id: "nested", artifactId: "artifact-nested", path: "foo/bar.md" }),
    ]);

    expect(tree).toHaveLength(2);
    expect(tree.find((node) => node.isDir)?.label).toBe("foo · folder");
    expect(tree.find((node) => !node.isDir)?.label).toBe("foo · file");
    const expanded = flattenTreeForRendering(tree, new Set(["foo"]));
    expect(expanded.map(({ node }) => [node.isDir, node.path, node.rowId])).toEqual([
      [true, "foo", undefined],
      [false, "foo/bar.md", "nested"],
      [false, "foo", "file-foo"],
    ]);
  });
  test("marker-only folder builds dir node without visible leaf in flatten", () => {
    const tree = buildTreeFromArtifacts([
      dto({ id: "m", artifactId: "am", path: "empty/.nautilo-keep.md", mimeType: "text/markdown" }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].isDir).toBe(true);
    expect(tree[0].name).toBe("empty");
    const flat = flattenTreeForRendering(tree, new Set(["empty"]));
    expect(flat.map((r) => r.node.name)).toEqual(["empty"]);
  });

  test("marker plus sibling file shows dir and real child only", () => {
    const tree = buildTreeFromArtifacts([
      dto({ id: "m", artifactId: "am", path: "box/.nautilo-keep.md", mimeType: "text/markdown" }),
      dto({ id: "f", artifactId: "af", path: "box/readme.md", mimeType: "text/markdown" }),
    ]);
    const box = tree[0];
    expect(box.isDir).toBe(true);
    expect(box.children?.map((c) => c.name).sort()).toEqual([".nautilo-keep.md", "readme.md"]);
    const flat = flattenTreeForRendering(tree, new Set(["box"]));
    expect(flat.map((r) => r.node.name)).toEqual(["box", "readme.md"]);
  });
});

describe("flattenTreeForRendering", () => {
  test("respects expanded set for directories", () => {
    const roots = buildTreeFromArtifacts([
      dto({ id: "1", artifactId: "a", path: "p/q.txt" }),
    ]);
    const collapsed = flattenTreeForRendering(roots, new Set());
    expect(collapsed.map((r) => r.node.name)).toEqual(["p"]);
    const expanded = flattenTreeForRendering(roots, new Set(["p"]));
    expect(expanded.map((r) => r.node.name)).toEqual(["p", "q.txt"]);
  });
});
