import { describe, expect, test } from "bun:test";
import {
  compareArtifactNodes,
  DEFAULT_ARTIFACT_SORT_CONFIG,
  type ArtifactSortableNode,
  type ArtifactSortConfig,
} from "./artifact-sort";

function node(partial: Partial<ArtifactSortableNode> & Pick<ArtifactSortableNode, "name">): ArtifactSortableNode {
  return {
    isDir: false,
    ...partial,
  };
}

function sortNames(nodes: ArtifactSortableNode[], cfg: ArtifactSortConfig = DEFAULT_ARTIFACT_SORT_CONFIG): string[] {
  return [...nodes].sort((a, b) => compareArtifactNodes(a, b, cfg)).map((n) => n.name);
}

describe("compareArtifactNodes", () => {
  test("folders first by default", () => {
    const cfg = DEFAULT_ARTIFACT_SORT_CONFIG;
    const nodes = [
      node({ name: "file.txt" }),
      node({ name: "dir", isDir: true }),
    ];
    expect(sortNames(nodes, cfg)).toEqual(["dir", "file.txt"]);
  });

  test("name ascending", () => {
    const cfg: ArtifactSortConfig = { mode: "name", dir: "asc", foldersFirst: false };
    expect(
      sortNames(
        [node({ name: "b" }), node({ name: "a" }), node({ name: "c" })],
        cfg,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  test("name descending", () => {
    const cfg: ArtifactSortConfig = { mode: "name", dir: "desc", foldersFirst: false };
    expect(sortNames([node({ name: "b" }), node({ name: "a" })], cfg)).toEqual(["b", "a"]);
  });

  test("modified uses updatedAt", () => {
    const cfg: ArtifactSortConfig = { mode: "modified", dir: "asc", foldersFirst: false };
    expect(
      sortNames(
        [
          node({ name: "new", updatedAt: "2026-02-01T00:00:00.000Z" }),
          node({ name: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
        ],
        cfg,
      ),
    ).toEqual(["old", "new"]);
  });

  test("size ascending", () => {
    const cfg: ArtifactSortConfig = { mode: "size", dir: "asc", foldersFirst: false };
    expect(
      sortNames(
        [node({ name: "big", size: 100 }), node({ name: "small", size: 1 })],
        cfg,
      ),
    ).toEqual(["small", "big"]);
  });

  test("foldersFirst off interleaves by field", () => {
    const cfg: ArtifactSortConfig = { mode: "name", dir: "asc", foldersFirst: false };
    expect(
      sortNames(
        [
          node({ name: "b-dir", isDir: true }),
          node({ name: "a-file" }),
        ],
        cfg,
      ),
    ).toEqual(["a-file", "b-dir"]);
  });
});
