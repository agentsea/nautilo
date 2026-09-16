import { describe, expect, test } from "bun:test";
import {
  appendChild,
  createEmptyDocument,
  createNode,
  type DesignDocument,
} from "../scene-graph";
import {
  applySelection,
  hitTest,
  nodeContainsPoint,
  paintOrder,
  pointInNode,
  editableSelectionBounds,
  editableSelectionIds,
  isNodeEffectivelyHidden,
  isNodeEffectivelyLocked,
  selectionBounds,
} from "./selection";
import type { VectorNetwork } from "../vector";

function docWith(nodes: Array<Parameters<typeof createNode>[0]>): DesignDocument {
  let doc = createEmptyDocument();
  for (const input of nodes) {
    const node = createNode(input);
    doc = { ...doc, nodes: { ...doc.nodes, [node.id]: node } };
    if (input.parentId === null) {
      doc = appendChild(doc, null, node.id, "page-1");
    } else {
      doc = appendChild(doc, input.parentId, node.id);
    }
  }
  return doc;
}

describe("pointInNode", () => {
  test("includes edges and rejects zero-size nodes", () => {
    const node = createNode({ id: "n", type: "rectangle", parentId: null, x: 10, y: 10, width: 100, height: 50 });
    expect(pointInNode(node, { x: 10, y: 10 })).toBe(true);
    expect(pointInNode(node, { x: 110, y: 60 })).toBe(true);
    expect(pointInNode(node, { x: 9, y: 30 })).toBe(false);
    const empty = createNode({ id: "g", type: "group", parentId: null, x: 0, y: 0, width: 0, height: 0 });
    expect(pointInNode(empty, { x: 0, y: 0 })).toBe(false);
  });

  test("uses the displayed rotation for containment", () => {
    const node = createNode({ id: "n", type: "rectangle", parentId: null, x: 0, y: 0, width: 100, height: 20, rotation: 90 });
    expect(pointInNode(node, { x: 50, y: 50 })).toBe(true);
    expect(pointInNode(node, { x: 10, y: 10 })).toBe(false);
  });
});

describe("hitTest", () => {
  test("returns the top-most node under the point", () => {
    const doc = docWith([
      { id: "node-1", type: "rectangle", parentId: null, x: 0, y: 0, width: 200, height: 200 },
      { id: "node-2", type: "rectangle", parentId: null, x: 50, y: 50, width: 50, height: 50 },
    ]);
    // Overlapping region -> later-painted node-2 wins
    expect(hitTest(doc, "page-1", { x: 60, y: 60 })).toBe("node-2");
    // Only node-1 covers this point
    expect(hitTest(doc, "page-1", { x: 10, y: 10 })).toBe("node-1");
    // Empty canvas
    expect(hitTest(doc, "page-1", { x: 300, y: 300 })).toBeNull();
  });

  test("children are painted on top of their parent frame", () => {
    const doc = docWith([
      { id: "node-1", type: "frame", parentId: null, x: 0, y: 0, width: 300, height: 300 },
      { id: "node-2", type: "rectangle", parentId: "node-1", x: 20, y: 20, width: 40, height: 40 },
    ]);
    expect(hitTest(doc, "page-1", { x: 30, y: 30 })).toBe("node-2");
    expect(hitTest(doc, "page-1", { x: 200, y: 200 })).toBe("node-1");
  });

  test("paintOrder lists parent before child", () => {
    const doc = docWith([
      { id: "node-1", type: "frame", parentId: null, x: 0, y: 0, width: 300, height: 300 },
      { id: "node-2", type: "rectangle", parentId: "node-1", x: 20, y: 20, width: 40, height: 40 },
    ]);
    expect(paintOrder(doc, "page-1").map((n) => n.id)).toEqual(["node-1", "node-2"]);
  });

  test("does not hit hidden or locked nodes", () => {
    const doc = docWith([
      { id: "hidden", type: "rectangle", parentId: null, width: 40, height: 40, hidden: true },
      { id: "locked", type: "rectangle", parentId: null, width: 40, height: 40, locked: true },
    ]);
    expect(hitTest(doc, "page-1", { x: 10, y: 10 })).toBeNull();
  });

  test("inherits hidden and locked state from every ancestor", () => {
    const locked = docWith([
      { id: "parent", type: "frame", parentId: null, width: 100, height: 100, locked: true },
      { id: "child", type: "rectangle", parentId: "parent", x: 10, y: 10, width: 20, height: 20 },
    ]);
    expect(isNodeEffectivelyLocked(locked, "child")).toBe(true);
    expect(hitTest(locked, "page-1", { x: 15, y: 15 })).toBeNull();
    expect(editableSelectionIds(locked, ["child"])).toEqual([]);

    const hidden = docWith([
      { id: "parent", type: "frame", parentId: null, width: 100, height: 100, hidden: true },
      { id: "child", type: "rectangle", parentId: "parent", x: 10, y: 10, width: 20, height: 20 },
    ]);
    expect(isNodeEffectivelyHidden(hidden, hidden.nodes["child"]!)).toBe(true);
    expect(paintOrder(hidden, "page-1")).toEqual([]);
    expect(selectionBounds(hidden, ["child"])).toBeNull();
  });
});

describe("nodeContainsPoint (vector)", () => {
  // An open L-shaped path (local coords), node origin at (100, 100).
  const network: VectorNetwork = {
    vertices: [
      { id: "v0", x: 0, y: 0 },
      { id: "v1", x: 40, y: 0 },
    ],
    segments: [{ id: "s0", startVertexId: "v0", endVertexId: "v1" }],
    regions: [],
  };
  const vectorNode = createNode({
    id: "vec",
    type: "vector",
    parentId: null,
    x: 100,
    y: 100,
    width: 40,
    height: 1,
    vectorNetwork: network,
  });

  test("hits near the path (offset by node origin) within tolerance, misses far away", () => {
    // absolute path runs from (100,100) to (140,100)
    expect(nodeContainsPoint(vectorNode, { x: 120, y: 101 }, 3)).toBe(true);
    expect(nodeContainsPoint(vectorNode, { x: 120, y: 110 }, 3)).toBe(false);
    // zero tolerance requires landing on the path
    expect(nodeContainsPoint(vectorNode, { x: 120, y: 101 }, 0)).toBe(false);
  });

  test("hitTest selects a vector node when clicking near its path", () => {
    const doc = docWith([
      { id: "node-1", type: "vector", parentId: null, x: 100, y: 100, width: 40, height: 1, vectorNetwork: network },
    ]);
    expect(hitTest(doc, "page-1", { x: 120, y: 101 }, 3)).toBe("node-1");
    expect(hitTest(doc, "page-1", { x: 120, y: 130 }, 3)).toBeNull();
  });
});

describe("applySelection", () => {
  test("replace mode selects a single node or clears on empty click", () => {
    expect(applySelection([], "node-1", "replace")).toEqual(["node-1"]);
    expect(applySelection(["node-1", "node-2"], "node-3", "replace")).toEqual(["node-3"]);
    expect(applySelection(["node-1"], null, "replace")).toEqual([]);
  });

  test("toggle mode adds/removes and preserves selection on empty click", () => {
    expect(applySelection(["node-1"], "node-2", "toggle")).toEqual(["node-1", "node-2"]);
    expect(applySelection(["node-1", "node-2"], "node-1", "toggle")).toEqual(["node-2"]);
    expect(applySelection(["node-1"], null, "toggle")).toEqual(["node-1"]);
  });
});

describe("selectionBounds", () => {
  test("computes the union box of selected nodes", () => {
    const doc = docWith([
      { id: "node-1", type: "rectangle", parentId: null, x: 0, y: 0, width: 100, height: 100 },
      { id: "node-2", type: "rectangle", parentId: null, x: 150, y: 50, width: 50, height: 200 },
    ]);
    expect(selectionBounds(doc, ["node-1", "node-2"])).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 250,
    });
    expect(selectionBounds(doc, ["missing"])).toBeNull();
  });

  test("keeps connector vectors selectable but excludes them from generic edit bounds", () => {
    const network: VectorNetwork = {
      vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 }],
      segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }], regions: [],
    };
    const doc = docWith([
      { id: "shape", type: "rectangle", parentId: null, x: 0, y: 0, width: 20, height: 20 },
      { id: "connector", type: "vector", parentId: null, x: 100, y: 0, width: 100, height: 0, vectorNetwork: network,
        connector: { route: "straight", start: { x: 100, y: 0 }, end: { x: 200, y: 0 } } },
    ]);
    expect(editableSelectionIds(doc, ["connector", "shape"])).toEqual(["shape"]);
    expect(editableSelectionBounds(doc, ["connector"])).toBeNull();
    expect(editableSelectionBounds(doc, ["connector", "shape"])).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  test("uses rotated visual bounds", () => {
    const doc = docWith([
      { id: "rotated", type: "rectangle", parentId: null, x: 0, y: 0, width: 100, height: 20, rotation: 90 },
    ]);
    const bounds = selectionBounds(doc, ["rotated"])!;
    expect(bounds.x).toBeCloseTo(40);
    expect(bounds.y).toBeCloseTo(-40);
    expect(bounds.width).toBeCloseTo(20);
    expect(bounds.height).toBeCloseTo(100);
  });

  test("includes measured text overflow in the selection bounds", () => {
    const doc = docWith([
      { id: "text", type: "text", parentId: null, x: 10, y: 20, width: 20, height: 10, text: "overflow", fontSize: 10 },
    ]);
    expect(selectionBounds(doc, ["text"], (value) => value.length * 10)).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 12.5,
    });
  });
});
