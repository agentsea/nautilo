import { expect, test } from "bun:test";
import { appendChild, createEmptyDocument, createNode, type DesignDocument, type DesignNode } from "./scene-graph";
import { mergeThreeWayDesignScenes } from "./scene-merge";

function documentWithText(text: string): DesignDocument {
  const node = createNode({ id: "text-1", type: "text", parentId: null, text });
  return appendChild({ ...createEmptyDocument(), nodes: { "text-1": node } }, null, node.id, "page-1");
}

test("same-target identical edits merge even when parsed object key order differs", () => {
  const base = documentWithText("old");
  const local = documentWithText("shared update");
  const updated = local.nodes["text-1"]!;
  const reordered: DesignNode = Object.fromEntries(
    Object.entries(updated).reverse(),
  ) as DesignNode;
  const remote: DesignDocument = { ...local, nodes: { "text-1": reordered } };

  const result = mergeThreeWayDesignScenes(base, local, remote);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected identical same-target edits to merge.");
  expect(result.document.nodes["text-1"]?.text).toBe("shared update");
  expect(result.mergedNodeIds).toEqual(["text-1"]);
});
