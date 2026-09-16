import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { appendChild, createEmptyDocument, createNode, type DesignDocument } from "../scene-graph";
import { attachCanvasInteractions, connectorCreateFromGesture, keepsShapeToolActive, shouldBeginCanvasPan, vectorPrimitiveCreateFromDrag, type Tool } from "./interactions";
import { DesignStore } from "./store";
import { isEligibleConnectorTarget } from "./connector";
import type { PenPath } from "./pen";
import { createCanvasRenderer } from "./render";
import { nodeLocalToDocument, nodeTransformMatrix, transformPoint } from "../geometry";
import { snapTransformedResizeBoxToPageObjects } from "./gesture-geometry";
import { handlePoint } from "./handles";

function interactionHarness(
  doc = createEmptyDocument(),
  initialTool: Tool = "select",
  options: { editNodeId?: string | null; onTextEdit?: (nodeId: string) => void; pen?: PenPath | null } = {},
) {
  const window = new Window();
  const svg = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
  window.document.body.appendChild(svg);
  Object.defineProperty(svg, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 400, height: 300 }),
  });
  const store = new DesignStore(doc, "page-1");
  let tool = initialTool;
  let editNodeId = options.editNodeId ?? null;
  let viewport = { scale: 1, tx: 0, ty: 0 };
  let pen = options.pen ?? null;
  const detach = attachCanvasInteractions({
    svg: svg as unknown as SVGSVGElement,
    store,
    getViewport: () => viewport,
    setViewport: (next) => { viewport = next; },
    getTool: () => tool,
    setTool: (next) => { tool = next; },
    onTextEdit: options.onTextEdit ?? (() => {}),
    getEditNodeId: () => editNodeId,
    setEditNodeId: (next) => { editNodeId = next; },
    getPen: () => pen,
    setPen: (next) => { pen = next; },
    commitPen: () => {},
  });
  const pointer = (type: string, x: number, y: number, options: Record<string, unknown> = {}) =>
    new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y, ...options });
  const dispatch = (target: unknown, event: unknown): void => {
    (target as EventTarget).dispatchEvent(event as Event);
  };
  return { window, svg, store, detach, pointer, dispatch, getEditNodeId: () => editNodeId, getViewport: () => viewport, getPen: () => pen };
}

describe("pointer creation tool routing", () => {
  test("routes every bounded vector creation tool through one durable create and undo path", () => {
    const expected = [
      ["ellipse", "Ellipse", true],
      ["line", "Line", false],
      ["polygon", "Triangle", true],
      ["triangle", "Triangle", true],
      ["diamond", "Diamond", true],
      ["pentagon", "Pentagon", true],
      ["hexagon", "Hexagon", true],
      ["star", "Star", true],
      ["arrow", "Arrow", true],
    ] as const;
    for (const [tool, name, filled] of expected) {
      const route = vectorPrimitiveCreateFromDrag(tool, { x: 10, y: 20 }, { x: 110, y: 80 });
      if (!route) throw new Error(`${tool} should route to vector creation`);
      expect(route.name).toBe(name);
      expect(route.fills === undefined).toBe(!filled);
      const store = new DesignStore(createEmptyDocument(), "page-1");
      const id = store.addVectorNode(route.built, { name: route.name, ...(route.fills ? { fills: route.fills } : {}) });
      expect(store.getDocument().nodes[id]).toMatchObject({ type: "vector", name });
      expect(store.getDocument().nodes[id]?.vectorNetwork).toEqual(route.built.network);
      store.undo();
      expect(store.getDocument().nodes[id]).toBeUndefined();
    }
  });

  test("does not route non-vector tools through the primitive create path", () => {
    expect(vectorPrimitiveCreateFromDrag("rectangle", { x: 0, y: 0 }, { x: 20, y: 20 })).toBeNull();
    expect(vectorPrimitiveCreateFromDrag("pen", { x: 0, y: 0 }, { x: 20, y: 20 })).toBeNull();
  });

  test("keeps locked Shapes-menu variants active while one-shot creation tools reset", () => {
    for (const tool of ["rectangle", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "star", "arrow"] as const) {
      expect(keepsShapeToolActive(tool)).toBe(true);
    }
    for (const tool of ["frame", "text", "line", "pen", "connector", "select"] as const) {
      expect(keepsShapeToolActive(tool)).toBe(false);
    }
  });

  test("connector gestures resolve attached and free endpoints without targeting connectors", () => {
    const base = createEmptyDocument();
    const left = createNode({ id: "left", type: "rectangle", parentId: null, x: 0, y: 0, width: 100, height: 100 });
    const right = createNode({ id: "right", type: "frame", parentId: null, x: 200, y: 0, width: 100, height: 100, rotation: 90 });
    const connector = createNode({
      id: "connector", type: "vector", parentId: null, x: 120, y: 10, width: 20, height: 20,
      vectorNetwork: { vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 20, y: 20 }], segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }], regions: [] },
      connector: { route: "straight", start: { x: 120, y: 10 }, end: { x: 140, y: 30 } },
    });
    const doc = appendChild(appendChild(appendChild({ ...base, nodes: { left, right, connector } }, null, "left", "page-1"), null, "right", "page-1"), null, "connector", "page-1");
    const attached = connectorCreateFromGesture(doc, { x: 98, y: 50 }, { x: 250, y: 2 }, "left", "right");
    expect(attached.start.targetId).toBe("left");
    expect(attached.end.targetId).toBe("right");
    const attachedFree = connectorCreateFromGesture(doc, { x: 98, y: 50 }, { x: 160, y: 160 }, "left", null);
    expect(attachedFree.start.targetId).toBe("left");
    expect(attachedFree.end.targetId).toBeUndefined();
    const freeAttached = connectorCreateFromGesture(doc, { x: 160, y: 160 }, { x: 250, y: 2 }, null, "right");
    expect(freeAttached.start.targetId).toBeUndefined();
    expect(freeAttached.end.targetId).toBe("right");
    const rejected = connectorCreateFromGesture(doc, { x: 130, y: 20 }, { x: 160, y: 160 }, "connector", null);
    expect(rejected.start.targetId).toBeUndefined();

    const closed = createNode({
      id: "closed", type: "vector", parentId: null, x: 0, y: 0, width: 10, height: 10,
      vectorNetwork: { vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 0 }, { id: "c", x: 0, y: 10 }], segments: [], regions: [{ id: "r", vertexIds: ["a", "b", "c"] }] },
    });
    const open = createNode({
      id: "open", type: "vector", parentId: null, x: 0, y: 0, width: 10, height: 10,
      vectorNetwork: { vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 0 }], segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }], regions: [] },
    });
    const booleanShape = createNode({ id: "boolean", type: "group", parentId: null, booleanOp: "union" });
    expect(isEligibleConnectorTarget(closed)).toBe(true);
    expect(isEligibleConnectorTarget(booleanShape)).toBe(true);
    expect(isEligibleConnectorTarget(open)).toBe(false);
  });
});

describe("viewport gesture routing", () => {
  test("Space-left drag takes precedence over creation while middle drag always pans", () => {
    expect(shouldBeginCanvasPan(0, true)).toBe(true);
    expect(shouldBeginCanvasPan(0, false)).toBe(false);
    expect(shouldBeginCanvasPan(1, false)).toBe(true);
  });
});

describe("pointer gesture controller", () => {
  test("transformed Shift snapping reaches a nearby guide without a near-perpendicular runaway", () => {
    const start = { x: 40, y: 50, width: 100, height: 50 };
    const makeDocument = (guideX: number): DesignDocument => {
      const base = createEmptyDocument();
      const shape = createNode({ id: "shape", type: "rectangle", parentId: null, ...start });
      const guide = createNode({ id: "guide", type: "group", parentId: null, x: guideX, y: 0, width: 0, height: 0 });
      return appendChild(appendChild({ ...base, nodes: { shape, guide } }, null, "shape", "page-1"), null, "guide", "page-1");
    };
    const resize = { x: start.x, y: start.y, width: 130, height: 65 };
    const ordinary = nodeTransformMatrix({ ...createNode({ id: "basis", type: "rectangle", parentId: null, ...start }), rotation: 30 });
    const ordinaryPoint = transformPoint(handlePoint(resize, "se"), ordinary);
    const targetX = ordinaryPoint.x + 3;
    const snapped = snapTransformedResizeBoxToPageObjects(
      makeDocument(targetX), "page-1", "se", start, 30, 5, new Set(["shape"]),
      { scale: 1, tx: 0, ty: 0 }, { centered: false, preserveAspect: true }, ordinary,
    );
    const snappedPoint = transformPoint(handlePoint(snapped.box, "se"), ordinary);
    expect(snapped.guides).toEqual([{ axis: "x", value: targetX }]);
    expect(snappedPoint.x).toBeCloseTo(targetX, 8);
    expect(snapped.box.width / snapped.box.height).toBeCloseTo(2, 8);
    expect(Math.hypot(snappedPoint.x - ordinaryPoint.x, snappedPoint.y - ordinaryPoint.y)).toBeLessThanOrEqual(6);

    const perpendicular = nodeTransformMatrix({ ...createNode({ id: "basis", type: "rectangle", parentId: null, ...start }), rotation: 89.99 });
    const perpendicularPoint = transformPoint(handlePoint(resize, "se"), perpendicular);
    const rejected = snapTransformedResizeBoxToPageObjects(
      makeDocument(perpendicularPoint.x + 3), "page-1", "se", start, 30, 5,
      new Set(["shape"]), { scale: 1, tx: 0, ty: 0 },
      { centered: false, preserveAspect: true }, perpendicular,
    );
    expect(rejected.guides).toEqual([]);
    expect(rejected.box).toEqual(resize);
  });

  test("a transformed single-node resize follows its rendered handle axes and remains one undo step", () => {
    const base = createEmptyDocument();
    const shape = createNode({
      id: "shape", type: "rectangle", parentId: null,
      x: 80, y: 60, width: 120, height: 70, rotation: 30, skewX: 15,
    });
    const doc = appendChild({ ...base, nodes: { shape } }, null, "shape", "page-1");
    const window = new Window();
    const priorDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
    try {
      const renderer = createCanvasRenderer();
      window.document.body.appendChild(
        renderer.svg as unknown as Parameters<typeof window.document.body.appendChild>[0],
      );
      Object.defineProperty(renderer.svg, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 600, height: 400 }),
      });
      const store = new DesignStore(doc, "page-1");
      store.setSelection(["shape"]);
      renderer.render(doc, "page-1", { scale: 1, tx: 0, ty: 0 }, ["shape"]);
      let tool: Tool = "select";
      const detach = attachCanvasInteractions({
        svg: renderer.svg, store,
        getViewport: () => ({ scale: 1, tx: 0, ty: 0 }), setViewport: () => {},
        getTool: () => tool, setTool: (next) => { tool = next; }, onTextEdit: () => {},
        getEditNodeId: () => null, setEditNodeId: () => {}, getPen: () => null,
        setPen: () => {}, commitPen: () => {},
      });
      const handle = renderer.svg.querySelector<SVGRectElement>('[data-handle="se"]');
      if (!handle) throw new Error("Expected the rendered southeast resize handle.");
      const start = nodeLocalToDocument(shape, { x: shape.width, y: shape.height });
      expect(Number(handle.getAttribute("x")) + Number(handle.getAttribute("width")) / 2).toBeCloseTo(start.x, 8);
      expect(Number(handle.getAttribute("y")) + Number(handle.getAttribute("height")) / 2).toBeCloseTo(start.y, 8);
      const matrix = nodeTransformMatrix(shape);
      const localDelta = { x: 24, y: 13 };
      const worldDelta = {
        x: matrix.a * localDelta.x + matrix.c * localDelta.y,
        y: matrix.b * localDelta.x + matrix.d * localDelta.y,
      };
      const pointer = (type: string, x: number, y: number) =>
        new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y });
      const dispatch = (target: unknown, event: unknown): void => {
        (target as EventTarget).dispatchEvent(event as Event);
      };
      dispatch(handle, pointer("pointerdown", start.x, start.y));
      dispatch(renderer.svg, pointer("pointermove", start.x + worldDelta.x, start.y + worldDelta.y));
      dispatch(renderer.svg, pointer("pointerup", start.x + worldDelta.x, start.y + worldDelta.y));

      const resized = store.getDocument().nodes["shape"]!;
      const fixed = nodeLocalToDocument(resized, { x: 0, y: 0 });
      const dragged = nodeLocalToDocument(resized, { x: resized.width, y: resized.height });
      const originalFixed = nodeLocalToDocument(shape, { x: 0, y: 0 });
      expect(fixed.x).toBeCloseTo(originalFixed.x, 8);
      expect(fixed.y).toBeCloseTo(originalFixed.y, 8);
      expect(dragged.x).toBeCloseTo(start.x + worldDelta.x, 8);
      expect(dragged.y).toBeCloseTo(start.y + worldDelta.y, 8);
      expect(resized.rotation).toBeCloseTo(shape.rotation ?? 0, 8);
      expect(resized.skewX).toBeCloseTo(shape.skewX ?? 0, 8);
      store.undo();
      expect(store.getDocument().nodes["shape"]).toEqual(shape);
      detach();
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
    }
  });

  test("a thick stroke does not move the opposite resize handle and cancellation restores it", () => {
    const base = createEmptyDocument();
    const shape = createNode({
      id: "shape", type: "rectangle", parentId: null,
      x: 40, y: 50, width: 100, height: 60, stroke: { color: "#111827", width: 20 },
    });
    const doc = appendChild({ ...base, nodes: { shape } }, null, "shape", "page-1");
    const harness = interactionHarness(doc);
    harness.store.setSelection(["shape"]);
    const handle = harness.window.document.createElementNS("http://www.w3.org/2000/svg", "rect");
    handle.dataset["handle"] = "se";
    harness.svg.appendChild(handle);
    harness.dispatch(handle, harness.pointer("pointerdown", 140, 110));
    harness.dispatch(harness.svg, harness.pointer("pointermove", 170, 125));
    const resized = harness.store.getDocument().nodes["shape"]!;
    expect(resized.x).toBeCloseTo(40, 8);
    expect(resized.y).toBeCloseTo(50, 8);
    expect(resized.x + resized.width).toBeCloseTo(170, 8);
    expect(resized.y + resized.height).toBeCloseTo(125, 8);
    harness.dispatch(harness.svg, harness.pointer("pointercancel", 170, 125));
    expect(harness.store.getDocument().nodes["shape"]).toEqual(shape);
    harness.detach();
  });

  test("Shift-Alt resize keeps a transformed node centered with its local aspect and transform", () => {
    const base = createEmptyDocument();
    const shape = createNode({
      id: "shape", type: "rectangle", parentId: null,
      x: 40, y: 50, width: 100, height: 50, rotation: 89, skewX: 12,
    });
    const doc = appendChild({ ...base, nodes: { shape } }, null, "shape", "page-1");
    const harness = interactionHarness(doc);
    harness.store.setSelection(["shape"]);
    const handle = harness.window.document.createElementNS("http://www.w3.org/2000/svg", "rect");
    handle.dataset["handle"] = "se";
    harness.svg.appendChild(handle);
    const start = nodeLocalToDocument(shape, { x: shape.width, y: shape.height });
    const matrix = nodeTransformMatrix(shape);
    const localDelta = { x: 30, y: 5 };
    const worldDelta = {
      x: matrix.a * localDelta.x + matrix.c * localDelta.y,
      y: matrix.b * localDelta.x + matrix.d * localDelta.y,
    };
    harness.dispatch(handle, harness.pointer("pointerdown", start.x, start.y));
    harness.dispatch(harness.svg, harness.pointer(
      "pointermove", start.x + worldDelta.x, start.y + worldDelta.y,
      { shiftKey: true, altKey: true },
    ));
    harness.dispatch(harness.svg, harness.pointer(
      "pointerup", start.x + worldDelta.x, start.y + worldDelta.y,
      { shiftKey: true, altKey: true },
    ));
    const resized = harness.store.getDocument().nodes["shape"]!;
    expect(resized.x + resized.width / 2).toBeCloseTo(shape.x + shape.width / 2, 8);
    expect(resized.y + resized.height / 2).toBeCloseTo(shape.y + shape.height / 2, 8);
    expect(resized.width / resized.height).toBeCloseTo(shape.width / shape.height, 8);
    expect(resized.width).toBeCloseTo(160, 8);
    expect(resized.height).toBeCloseTo(80, 8);
    expect(resized.rotation).toBeCloseTo(shape.rotation ?? 0, 8);
    expect(resized.skewX).toBeCloseTo(shape.skewX ?? 0, 8);
    expect([resized.x, resized.y, resized.width, resized.height, resized.rotation, resized.skewX]
      .every((value) => Number.isFinite(value))).toBe(true);
    harness.detach();
  });

  test("renders a constrained creation preview and pointercancel leaves no created object", () => {
    const { svg, store, detach, pointer, dispatch } = interactionHarness(createEmptyDocument(), "rectangle");
    dispatch(svg, pointer("pointerdown", 10, 10));
    dispatch(svg, pointer("pointermove", 30, 40, { shiftKey: true }));
    const preview = svg.querySelector('[data-gesture-preview="create"]');
    if (!preview) throw new Error("Expected a creation preview.");
    expect([preview.getAttribute("width"), preview.getAttribute("height")]).toEqual(["30", "30"]);
    dispatch(svg, pointer("pointercancel", 30, 40));
    expect(Object.keys(store.getDocument().nodes)).toEqual([]);
    expect(svg.querySelector("[data-gesture-preview]")).toBeNull();
    detach();
  });

  test("empty select drag selects the marquee region and Escape restores a transient move", () => {
    const base = createEmptyDocument();
    const first = createNode({ id: "first", type: "rectangle", parentId: null, x: 10, y: 10, width: 20, height: 20 });
    const second = createNode({ id: "second", type: "rectangle", parentId: null, x: 100, y: 10, width: 20, height: 20 });
    const doc = appendChild(appendChild({ ...base, nodes: { first, second } }, null, "first", "page-1"), null, "second", "page-1");
    const { window, svg, store, detach, pointer, dispatch } = interactionHarness(doc);
    dispatch(svg, pointer("pointerdown", 0, 0));
    dispatch(svg, pointer("pointermove", 40, 40));
    expect(svg.querySelector('[data-gesture-preview="marquee"]')).not.toBeNull();
    dispatch(svg, pointer("pointerup", 40, 40));
    expect(store.getState().selection).toEqual(["first"]);

    const target = window.document.createElementNS("http://www.w3.org/2000/svg", "rect");
    target.dataset["nodeId"] = "first";
    svg.appendChild(target);
    dispatch(svg, pointer("pointerdown", 15, 15));
    dispatch(svg, pointer("pointermove", 50, 15));
    expect(store.getDocument().nodes["first"]?.x).toBe(45);
    dispatch(window.document, new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(store.getDocument().nodes["first"]?.x).toBe(10);
    detach();
  });

  test("two-touch navigation cancels a one-finger edit and a nonfirst release leaves no ghost mutation", () => {
    const base = createEmptyDocument();
    const first = createNode({ id: "first", type: "rectangle", parentId: null, x: 10, y: 10, width: 20, height: 20 });
    const doc = appendChild({ ...base, nodes: { first } }, null, "first", "page-1");
    const { window, svg, store, detach, pointer, dispatch, getViewport } = interactionHarness(doc);
    const target = window.document.createElementNS("http://www.w3.org/2000/svg", "rect");
    target.dataset["nodeId"] = "first";
    svg.appendChild(target);
    store.setSelection(["first"]);

    const touch = (type: string, pointerId: number, x: number, y: number) =>
      pointer(type, x, y, { pointerId, pointerType: "touch" });

    dispatch(target, touch("pointerdown", 1, 15, 15));
    dispatch(svg, touch("pointermove", 1, 35, 15));
    expect(store.getDocument().nodes["first"]?.x).toBe(30);

    dispatch(svg, touch("pointerdown", 2, 100, 15));
    expect(store.getDocument().nodes["first"]?.x).toBe(10);

    dispatch(svg, touch("pointermove", 1, 55, 15));
    dispatch(svg, touch("pointermove", 2, 140, 15));
    expect(getViewport().scale).toBeGreaterThan(1);
    expect(getViewport().tx).toBeGreaterThan(0);

    // Releasing the second finger must stop navigation and leave the cancelled
    // document gesture cancelled. Further movement of the first finger cannot
    // resurrect its old drag state.
    dispatch(svg, touch("pointerup", 2, 140, 15));
    const viewportAfterRelease = getViewport();
    dispatch(svg, touch("pointermove", 1, 120, 15));
    dispatch(svg, touch("pointerup", 1, 120, 15));
    expect(getViewport()).toEqual(viewportAfterRelease);
    expect(store.getDocument().nodes["first"]?.x).toBe(10);
    expect(store.getState().selection).toEqual(["first"]);

    // Cancellation follows the same rule: the remaining touch stays consumed
    // and cannot restart the move that the second touch had cancelled.
    dispatch(target, touch("pointerdown", 3, 15, 15));
    dispatch(svg, touch("pointerdown", 4, 100, 15));
    dispatch(svg, touch("pointermove", 4, 140, 15));
    dispatch(svg, touch("pointercancel", 4, 140, 15));
    const viewportAfterCancel = getViewport();
    dispatch(svg, touch("pointermove", 3, 120, 15));
    dispatch(svg, touch("pointerup", 3, 120, 15));
    expect(getViewport()).toEqual(viewportAfterCancel);
    expect(store.getDocument().nodes["first"]?.x).toBe(10);
    detach();
  });

  test("two-touch navigation restores the pre-touch selection", () => {
    const base = createEmptyDocument();
    const first = createNode({ id: "first", type: "rectangle", parentId: null, x: 0, y: 0, width: 20, height: 20 });
    const second = createNode({ id: "second", type: "rectangle", parentId: null, x: 50, y: 0, width: 20, height: 20 });
    const doc = appendChild(appendChild({ ...base, nodes: { first, second } }, null, "first", "page-1"), null, "second", "page-1");
    const { window, svg, store, detach, pointer, dispatch } = interactionHarness(doc);
    const target = window.document.createElementNS("http://www.w3.org/2000/svg", "rect");
    target.dataset["nodeId"] = "second";
    svg.appendChild(target);
    store.setSelection(["first"]);
    const touch = (type: string, pointerId: number, x: number, y: number) =>
      pointer(type, x, y, { pointerId, pointerType: "touch" });

    dispatch(target, touch("pointerdown", 1, 55, 10));
    expect(store.getState().selection).toEqual(["second"]);
    dispatch(svg, touch("pointerdown", 2, 120, 10));
    expect(store.getState().selection).toEqual(["first"]);
    dispatch(svg, touch("pointerup", 2, 120, 10));
    dispatch(svg, touch("pointerup", 1, 55, 10));
    detach();
  });

  test("two-touch pan preserves a pre-existing pen path and discards only its provisional anchor", () => {
    const prior: PenPath = { anchors: [{ x: 10, y: 10 }], closed: false };
    const { svg, store, detach, pointer, dispatch, getPen, getViewport } = interactionHarness(
      createEmptyDocument(),
      "pen",
      { pen: prior },
    );
    store.setSelection([]);
    const touch = (type: string, pointerId: number, x: number, y: number) =>
      pointer(type, x, y, { pointerId, pointerType: "touch" });

    dispatch(svg, touch("pointerdown", 1, 30, 20));
    expect(getPen()?.anchors).toHaveLength(2);
    dispatch(svg, touch("pointerdown", 2, 130, 20));
    expect(getPen()).toEqual(prior);
    dispatch(svg, touch("pointermove", 1, 50, 20));
    expect(getViewport().tx).toBeGreaterThan(0);
    dispatch(svg, touch("pointerup", 2, 130, 20));
    dispatch(svg, touch("pointerup", 1, 50, 20));

    const viewportAfterPan = getViewport();
    dispatch(svg, touch("pointerdown", 3, 40, 40));
    dispatch(svg, touch("pointerup", 3, 40, 40));
    expect(getPen()).toEqual({
      anchors: [
        { x: 10, y: 10 },
        { x: (40 - viewportAfterPan.tx) / viewportAfterPan.scale, y: (40 - viewportAfterPan.ty) / viewportAfterPan.scale },
      ],
      closed: false,
    });
    detach();
  });

  test("a coincident touch pair pans at its current scale before a separated pinch rebaselines", () => {
    const { svg, detach, pointer, dispatch, getViewport } = interactionHarness();
    const touch = (type: string, pointerId: number, x: number, y: number) =>
      pointer(type, x, y, { pointerId, pointerType: "touch" });

    dispatch(svg, touch("pointerdown", 1, 100, 100));
    dispatch(svg, touch("pointerdown", 2, 100, 100));
    dispatch(svg, touch("pointermove", 1, 90, 100));
    expect(getViewport().scale).toBe(1);
    expect(getViewport().tx).toBe(-5);
    dispatch(svg, touch("pointermove", 1, 80, 100));
    expect(getViewport().scale).toBeGreaterThan(1);
    detach();
  });

  test("stale layer selection cannot edit descendants of a locked container", () => {
    const base = createEmptyDocument();
    const parent = createNode({ id: "parent", type: "frame", parentId: null, width: 200, height: 100, locked: true });
    const vector = createNode({
      id: "vector", type: "vector", parentId: "parent", x: 10, y: 10, width: 30, height: 20,
      vectorNetwork: {
        vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 0 }, { id: "c", x: 15, y: 20 }],
        segments: [{ id: "ab", startVertexId: "a", endVertexId: "b" }],
        regions: [{ id: "face", vertexIds: ["a", "b", "c"] }],
      },
    });
    const connector = createNode({
      id: "connector", type: "vector", parentId: "parent", x: 60, y: 20, width: 80, height: 0,
      vectorNetwork: { vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 80, y: 0 }], segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }], regions: [] },
      connector: { route: "straight", start: { x: 60, y: 20 }, end: { x: 140, y: 20 } },
    });
    const text = createNode({ id: "text", type: "text", parentId: "parent", x: 20, y: 50, width: 80, height: 20, text: "Locked" });
    let doc: DesignDocument = { ...base, nodes: { parent, vector, connector, text } };
    doc = appendChild(doc, null, "parent", "page-1");
    doc = appendChild(doc, "parent", "vector");
    doc = appendChild(doc, "parent", "connector");
    doc = appendChild(doc, "parent", "text");
    let textEdits = 0;
    const harness = interactionHarness(doc, "select", { editNodeId: "vector", onTextEdit: () => { textEdits += 1; } });
    const before = JSON.stringify(harness.store.getDocument());

    harness.store.setSelection(["vector"]);
    harness.dispatch(harness.svg, harness.pointer("pointerdown", 10, 10));
    harness.dispatch(harness.svg, harness.pointer("pointermove", 30, 30));
    harness.dispatch(harness.svg, harness.pointer("pointerup", 30, 30));
    expect(harness.getEditNodeId()).toBeNull();

    harness.store.setSelection(["connector"]);
    const endpoint = harness.window.document.createElementNS("http://www.w3.org/2000/svg", "circle");
    endpoint.dataset["connectorEnd"] = "start";
    harness.svg.appendChild(endpoint);
    harness.dispatch(endpoint, harness.pointer("pointerdown", 60, 20));
    harness.dispatch(harness.svg, harness.pointer("pointermove", 90, 30));
    harness.dispatch(harness.svg, harness.pointer("pointerup", 90, 30));

    harness.dispatch(harness.svg, new harness.window.MouseEvent("dblclick", { bubbles: true, clientX: 30, clientY: 60 }));
    expect(textEdits).toBe(0);
    expect(JSON.stringify(harness.store.getDocument())).toBe(before);
    harness.detach();
  });
});
