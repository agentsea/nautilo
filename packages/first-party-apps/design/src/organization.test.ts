import { expect, test } from "bun:test";
import { createEmptyDocument, createNode, type DesignDocument } from "./scene-graph";
import { applyDesignTransaction, type DesignTransactionRequest } from "./transactions";
import { copyDesignFragment } from "./organization";
import { nodeCorners, transformPoint } from "./geometry";
import { DesignStore } from "./editor/store";

function fixture(): DesignDocument {
  const doc = createEmptyDocument();
  doc.nodes = {
    a: createNode({ id: "a", type: "rectangle", parentId: null, x: 10, y: 20, width: 80, height: 40, rotation: 35 }),
    b: createNode({ id: "b", type: "rectangle", parentId: null, x: 120, y: 30, width: 50, height: 60 }),
  };
  doc.pages[0]!.children = ["a", "b"];
  return doc;
}
function apply(doc: DesignDocument, request: DesignTransactionRequest): DesignDocument {
  const result = applyDesignTransaction(doc, request);
  if (!result.ok) throw new Error(result.error.message);
  return result.document;
}

test("group transforms descendants once, preserves skew under nonuniform resize, and ungroups in place", () => {
  const original = fixture();
  const grouped = apply(original, { kind: "group", nodeIds: ["a", "b"] });
  const id = grouped.pages[0]!.children[0]!;
  const matrix = { a: 2, b: 0, c: 0, d: 0.75, e: 11, f: -7 };
  const resized = apply(grouped, { kind: "affine", nodeIds: [id, "a"], matrix });
  const corners = nodeCorners(resized.nodes["a"]!);
  nodeCorners(original.nodes["a"]!).map((point) => transformPoint(point, matrix)).forEach((point, index) => {
    expect(corners[index]!.x).toBeCloseTo(point.x, 9);
    expect(corners[index]!.y).toBeCloseTo(point.y, 9);
  });
  expect(Math.abs(resized.nodes["a"]!.skewX!)).toBeGreaterThan(1);
  const ungrouped = apply(resized, { kind: "ungroup", nodeIds: [id] });
  expect(ungrouped.pages[0]!.children).toEqual(["a", "b"]);
  expect(nodeCorners(ungrouped.nodes["a"]!)).toEqual(corners);
  expect(original.nodes["a"]!.parentId).toBeNull();
});

test("moving and rotating a group bakes its descendants into absolute document coordinates", () => {
  const grouped = apply(fixture(), { kind: "group", nodeIds: ["a", "b"] });
  const id = grouped.pages[0]!.children[0]!;
  const group = grouped.nodes[id]!;
  const moved = apply(grouped, { kind: "transform", updates: [{ nodeId: id, x: group.x + 40, y: group.y - 10 }] });
  expect(moved.nodes["a"]!.x).toBe(50);
  expect(moved.nodes["a"]!.y).toBe(10);
  const rotated = apply(moved, { kind: "rotate", nodeIds: [id], rotation: 90 });
  expect(rotated.nodes["a"]!.rotation).toBeCloseTo(125);
  expect(rotated.nodes["a"]!.x).not.toBe(moved.nodes["a"]!.x);
});

test("clipboard and duplicate remap descendants while retaining source parents and independent state", () => {
  const grouped = apply(fixture(), { kind: "group", nodeIds: ["a", "b"] });
  const groupId = grouped.pages[0]!.children[0]!;
  const duplicated = apply(grouped, { kind: "duplicate", nodeIds: ["a"], dx: 20, dy: 20 });
  const cloneId = duplicated.nodes[groupId]!.childIds[1]!;
  expect(duplicated.nodes[cloneId]).toMatchObject({ parentId: groupId, x: 30, y: 40 });
  expect(grouped.nodes[groupId]!.childIds).toEqual(["a", "b"]);
  const fragment = copyDesignFragment(grouped, [groupId]);
  const inserted = apply(createEmptyDocument(), { kind: "insert", fragment, pageId: "page-1", dx: 0, dy: 0 });
  expect(Object.keys(inserted.nodes)).toHaveLength(3);
  expect(inserted.nodes[inserted.pages[0]!.children[0]!]!.childIds).toHaveLength(2);
});

test("reparent rejects ancestry cycles atomically and page deletion preserves a usable empty page", () => {
  const grouped = apply(fixture(), { kind: "group", nodeIds: ["a", "b"] });
  const id = grouped.pages[0]!.children[0]!;
  expect(applyDesignTransaction(grouped, { kind: "reparent", nodeIds: [id], parentId: id, pageId: "page-1" }).ok).toBe(false);
  const moved = apply(grouped, { kind: "reparent", nodeIds: ["a"], parentId: null, pageId: "page-1" });
  expect(moved.nodes["a"]!.parentId).toBeNull();
  expect(moved.nodes[id]!.childIds).toEqual(["b"]);
  const empty = apply(moved, { kind: "page-edit", action: "delete", pageId: "page-1" });
  expect(empty.pages).toHaveLength(1);
  expect(empty.pages[0]!.children).toEqual([]);
  expect(Object.keys(empty.nodes)).toHaveLength(0);
});

test("reflection retains exact rotated corners and double flip restores the artwork", () => {
  const doc = fixture();
  const matrix = { a: -1, b: 0, c: 0, d: 1, e: 200, f: 0 };
  const flipped = apply(doc, { kind: "affine", nodeIds: ["a"], matrix });
  nodeCorners(doc.nodes["a"]!).forEach((point, i) => {
    expect(nodeCorners(flipped.nodes["a"]!)[i]!.x).toBeCloseTo(200 - point.x);
    expect(nodeCorners(flipped.nodes["a"]!)[i]!.y).toBeCloseTo(point.y);
  });
  const restored = apply(flipped, { kind: "affine", nodeIds: ["a"], matrix });
  nodeCorners(doc.nodes["a"]!).forEach((point, i) => {
    expect(nodeCorners(restored.nodes["a"]!)[i]!.x).toBeCloseTo(point.x);
    expect(nodeCorners(restored.nodes["a"]!)[i]!.y).toBeCloseTo(point.y);
  });
});

test("cancel restores a group gesture and committed structural edits undo as one action", () => {
  const doc = fixture();
  const store = new DesignStore(doc);
  store.organize({ kind: "group", nodeIds: ["a", "b"] });
  const grouped = store.getDocument();
  store.beginTransient();
  store.transformTransient(grouped.pages[0]!.children, { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 });
  store.cancelTransient();
  expect(store.getDocument()).toBe(grouped);
  store.undo();
  expect(store.getDocument()).toBe(doc);
});


test("path resize transforms serialized path geometry and rejects ambiguous transform batches", () => {
  const doc = fixture();
  doc.nodes["a"] = createNode({ id: "a", type: "vector", parentId: null, x: 0, y: 0, width: 10, height: 10, vectorPath: "M0 0 L10 10" });
  const resized = apply(doc, { kind: "transform", updates: [{ nodeId: "a", width: 20, height: 30 }] });
  expect(resized.nodes["a"]!.vectorPath).toBe("M 0 0 L 20 30");
  const grouped = apply(doc, { kind: "group", nodeIds: ["a", "b"] });
  const groupId = grouped.pages[0]!.children[0]!;
  expect(applyDesignTransaction(grouped, { kind: "transform", updates: [{ nodeId: groupId, x: 100 }, { nodeId: "a", x: 200 }] }).ok).toBe(false);
  expect(grouped.nodes["a"]!.x).toBe(0);
  doc.nodes["a"].width = 0;
  expect(applyDesignTransaction(doc, { kind: "transform", updates: [{ nodeId: "a", width: 20 }] }).ok).toBe(false);
});

test("ungroup refuses an appearance-changing opacity flatten", () => {
  const grouped = apply(fixture(), { kind: "group", nodeIds: ["a", "b"] });
  const id = grouped.pages[0]!.children[0]!;
  grouped.nodes[id]!.opacity = 0.5;
  const result = applyDesignTransaction(grouped, { kind: "ungroup", nodeIds: [id] });
  expect(result.ok).toBe(false);
  expect(grouped.nodes[id]!.opacity).toBe(0.5);
});

test("flags apply to every explicitly named node including a selected descendant", () => {
  const grouped = apply(fixture(), { kind: "group", nodeIds: ["a", "b"] });
  const groupId = grouped.pages[0]!.children[0]!;
  const hidden = apply(grouped, { kind: "flags", nodeIds: [groupId, "a"], hidden: true, locked: true });
  expect(hidden.nodes[groupId]).toMatchObject({ hidden: true, locked: true });
  expect(hidden.nodes["a"]).toMatchObject({ hidden: true, locked: true });
  const shown = apply(hidden, { kind: "flags", nodeIds: [groupId, "a"], hidden: false, locked: false });
  expect(shown.nodes[groupId]).toMatchObject({ hidden: false, locked: false });
  expect(shown.nodes["a"]).toMatchObject({ hidden: false, locked: false });
});

test("cross-page moves detach only connector endpoints that leave their target page", () => {
  const doc = fixture();
  doc.pages.push({ id: "page-2", name: "Second", children: [] });
  doc.nodes["connector"] = createNode({ id: "connector", type: "vector", parentId: null,
    connector: { route: "straight", start: { x: 0, y: 0, targetId: "b", anchor: { x: 0, y: 0.5 } }, end: { x: 300, y: 300 } },
  });
  doc.pages[0]!.children.push("connector");
  for (const ids of [["b"], ["connector"]]) {
    const moved = apply(doc, { kind: "reparent", nodeIds: ids, parentId: null, pageId: "page-2" });
    expect(moved.nodes["connector"]?.connector?.start).toEqual({ x: 120, y: 60, detachedFromTargetId: "b" });
  }
  const together = apply(doc, { kind: "reparent", nodeIds: ["b", "connector"], parentId: null, pageId: "page-2" });
  expect(together.nodes["connector"]?.connector?.start.targetId).toBe("b");
  expect(doc.nodes["connector"]?.connector?.start.targetId).toBe("b");
});

test("editor resizing preserves explicit stroke styling in document units", () => {
  const doc = fixture();
  doc.nodes["a"]!.stroke = { color: "#000000", width: 4, dash: [3, 2] };
  const resized = apply(doc, { kind: "affine", nodeIds: ["a"], matrix: { a: 2, b: 0, c: 0, d: 0.5, e: 0, f: 0 } });
  expect(resized.nodes["a"]?.stroke).toEqual(doc.nodes["a"]!.stroke);
});

test("overflowing legacy path coordinates reject the complete transform atomically", () => {
  const doc = createEmptyDocument();
  doc.nodes["p"] = createNode({ id: "p", type: "vector", parentId: null, width: 1, height: 1, vectorPath: "M 0 0 L 10000000000 1" });
  doc.pages[0]!.children = ["p"];
  const result = applyDesignTransaction(doc, { kind: "affine", nodeIds: ["p"], matrix: { a: 1e308, b: 0, c: 0, d: 1, e: 0, f: 0 } });
  expect(result.ok).toBe(false);
  expect(doc.nodes["p"]?.vectorPath).toBe("M 0 0 L 10000000000 1");
});
