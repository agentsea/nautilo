import { describe, expect, test } from "bun:test";
import { appendChild, createEmptyDocument, createNode, type DesignDocument } from "../scene-graph";
import {
  constrainDragPoint,
  creationEndpoints,
  dragBox,
  boxAffineMatrix,
  marqueeSelectionIds,
  resizeBoxFromCenter,
  resizeBoxWithModifiers,
  snapBoxToPageObjects,
  snapResizeBoxToPageObjects,
} from "./gesture-geometry";

describe("gesture geometry", () => {
  test("Shift constrains rectangular and line-like creation without changing an unconstrained drag", () => {
    expect(constrainDragPoint({ x: 0, y: 0 }, { x: 30, y: 10 }, true, false)).toEqual({ x: 30, y: 30 });
    expect(constrainDragPoint({ x: 0, y: 0 }, { x: 30, y: 10 }, true, true)).toEqual({ x: 31.622776601683793, y: 0 });
    expect(constrainDragPoint({ x: 0, y: 0 }, { x: 30, y: 10 }, false, false)).toEqual({ x: 30, y: 10 });
  });

  test("Alt creates symmetrically around the pointer-down origin", () => {
    expect(dragBox({ x: 50, y: 50 }, { x: 70, y: 60 }, true)).toEqual({ x: 30, y: 40, width: 40, height: 20 });
    expect(creationEndpoints({ x: 50, y: 50 }, { x: 70, y: 60 }, true)).toEqual({ start: { x: 30, y: 40 }, end: { x: 70, y: 60 } });
  });

  test("Alt resize keeps the selection center fixed and maps the original box exactly", () => {
    const start = { x: 10, y: 20, width: 40, height: 30 };
    const next = resizeBoxFromCenter("se", start, 10, 5);
    expect(next).toEqual({ x: 0, y: 15, width: 60, height: 40 });
    expect(boxAffineMatrix(start, next)).toMatchObject({ a: 1.5, b: 0, c: 0, d: 4 / 3, e: -15 });
    expect(boxAffineMatrix(start, next).f).toBeCloseTo(-35 / 3);
  });

  test("Shift keeps the starting aspect ratio for corner and edge resizes", () => {
    const start = { x: 10, y: 20, width: 40, height: 30 };
    expect(resizeBoxWithModifiers("se", start, 20, 4, false, true)).toEqual({
      x: 10, y: 20, width: 60, height: 45,
    });
    expect(resizeBoxWithModifiers("e", start, 10, 0, false, true)).toEqual({
      x: 10, y: 16.25, width: 50, height: 37.5,
    });
  });

  test("marquee uses visual bounds and excludes hidden or locked objects", () => {
    const base = createEmptyDocument();
    const rotated = createNode({ id: "rotated", type: "rectangle", parentId: null, x: 10, y: 10, width: 40, height: 10, rotation: 90 });
    const hidden = createNode({ id: "hidden", type: "rectangle", parentId: null, x: 20, y: 20, width: 10, height: 10, hidden: true });
    const locked = createNode({ id: "locked", type: "rectangle", parentId: null, x: 30, y: 20, width: 10, height: 10, locked: true });
    let doc: DesignDocument = { ...base, nodes: { rotated, hidden, locked } };
    doc = appendChild(appendChild(appendChild(doc, null, "rotated", "page-1"), null, "hidden", "page-1"), null, "locked", "page-1");
    expect(marqueeSelectionIds(doc, "page-1", { x: 20, y: -10, width: 10, height: 10 })).toEqual(["rotated"]);
  });

  test("marquee cannot select descendants of a locked container", () => {
    const group = { ...createNode({ id: "group", type: "group", parentId: null, locked: true }), childIds: ["child"] };
    const child = createNode({ id: "child", type: "rectangle", parentId: "group", x: 10, y: 10, width: 20, height: 20 });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { group, child } }, null, "group", "page-1");
    expect(marqueeSelectionIds(doc, "page-1", { x: 0, y: 0, width: 100, height: 100 })).toEqual([]);
  });

  test("snapping compares screen distance and emits only the active axes", () => {
    const base = createEmptyDocument();
    const target = createNode({ id: "target", type: "rectangle", parentId: null, x: 100, y: 100, width: 40, height: 40 });
    const doc = appendChild({ ...base, nodes: { target } }, null, "target", "page-1");
    expect(snapBoxToPageObjects(doc, "page-1", { x: 95, y: 147, width: 20, height: 20 }, new Set(), { scale: 1, tx: 0, ty: 0 })).toEqual({
      box: { x: 100, y: 147, width: 20, height: 20 }, guides: [{ axis: "x", value: 100 }],
    });
    expect(snapBoxToPageObjects(doc, "page-1", { x: 85, y: 147, width: 20, height: 20 }, new Set(), { scale: 2, tx: 0, ty: 0 })).toEqual({
      box: { x: 85, y: 147, width: 20, height: 20 }, guides: [],
    });
  });

  test("resize snapping keeps its opposite anchor or Alt center and lets Shift choose one guide", () => {
    const base = createEmptyDocument();
    const target = createNode({ id: "target", type: "rectangle", parentId: null, x: 70, y: 50, width: 20, height: 20 });
    const doc = appendChild({ ...base, nodes: { target } }, null, "target", "page-1");
    const start = { x: 10, y: 20, width: 40, height: 30 };

    const pinned = snapResizeBoxToPageObjects(
      doc, "page-1", "se", start, 19, 4, new Set(), { scale: 1, tx: 0, ty: 0 },
      { centered: false, preserveAspect: false },
    );
    expect(pinned).toEqual({
      box: { x: 10, y: 20, width: 60, height: 30 },
      guides: [{ axis: "x", value: 70 }, { axis: "y", value: 50 }],
    });

    const centered = snapResizeBoxToPageObjects(
      doc, "page-1", "se", start, 19, 5, new Set(), { scale: 1, tx: 0, ty: 0 },
      { centered: true, preserveAspect: false },
    );
    expect(centered.box).toEqual({ x: -10, y: 20, width: 80, height: 30 });
    expect(centered.guides).toEqual([{ axis: "x", value: 70 }, { axis: "y", value: 50 }]);
    expect({ x: centered.box.x + centered.box.width / 2, y: centered.box.y + centered.box.height / 2 }).toEqual({ x: 30, y: 35 });

    const aspect = snapResizeBoxToPageObjects(
      doc, "page-1", "se", start, 19, 4, new Set(), { scale: 1, tx: 0, ty: 0 },
      { centered: false, preserveAspect: true },
    );
    expect(aspect).toEqual({
      box: { x: 10, y: 20, width: 60, height: 45 },
      guides: [{ axis: "x", value: 70 }],
    });
  });
});
