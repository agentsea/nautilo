/**
 * Pointer/wheel interaction controller for the design canvas. Translates DOM
 * events into store mutations and viewport changes. It owns no state of its own
 * beyond the in-flight drag; the viewport and active tool live in the mount
 * (main.ts) and are read/written through callbacks so the mount stays the
 * orchestrator. All geometry math is delegated to the pure viewport/handles
 * modules.
 */

import {
  editableSelectionBounds,
  editableSelectionIds,
  hitTest,
  isNodeEffectivelyHidden,
  isNodeEffectivelyLocked,
} from "./selection";
import { moveBox, type Box, type HandleId } from "./handles";
import { inverseMatrix, multiplyMatrices } from "../affine-transform";
import { nodeTransformMatrix, transformPoint, type GeometryMatrix } from "../geometry";
import { canvasToScreen, clampScale, screenToCanvas, zoomAt, panBy, type Point, type Viewport } from "./viewport";
import type { DesignStore } from "./store";
import { emptyPenPath, nearFirstAnchor, type PenPath } from "./pen";
import { applyVectorNodeDrag, hitVectorNodePart, type VectorPart } from "./vector-edit";
import {
  buildPrimitiveFromDrag,
  isVectorPrimitiveTool as isPrimitiveTool,
  primitiveDisplayName,
  type CommonShapeTool,
  type PrimitiveTool,
} from "./primitives";
import type { ConnectorEndpoint, DesignConnector, DesignFill, DesignDocument } from "../scene-graph";
import { connectorEndpointForPoint } from "./connector";
import {
  constrainDragPoint,
  boxAffineMatrix,
  creationEndpoints,
  dragBox,
  marqueeSelectionIds,
  snapResizeBoxToPageObjects,
  snapTransformedResizeBoxToPageObjects,
  snapBoxToPageObjects,
  type SnapGuide,
} from "./gesture-geometry";

export type Tool = "select" | "frame" | "text" | "rectangle" | "ellipse" | "line" | "polygon" | CommonShapeTool | "connector" | "pen";

type CreateTool = Exclude<Tool, "select" | "pen">;

export type InteractionDeps = {
  svg: SVGSVGElement;
  store: DesignStore;
  getViewport: () => Viewport;
  setViewport: (viewport: Viewport) => void;
  /** The mount owns keyboard state; held Space temporarily takes precedence over tools. */
  getSpacePanning?: () => boolean;
  getTool: () => Tool;
  setTool: (tool: Tool) => void;
  onTextEdit: (nodeId: string) => void;
  // node-edit mode (double-click a vector to edit its anchors/handles)
  getEditNodeId: () => string | null;
  setEditNodeId: (nodeId: string | null) => void;
  onVectorPartSelected?: (part: VectorPart) => void;
  // in-progress pen path (owned by the mount so the renderer can preview it)
  getPen: () => PenPath | null;
  setPen: (pen: PenPath | null, cursor: Point | null) => void;
  /** Finish the pen: build a vector node from `path` (called on close). */
  commitPen: (path: PenPath) => void;
};

type DragState =
  | { kind: "pan"; lastScreen: Point }
  | { kind: "move"; startCanvas: Point; startGroup: Box; startBoxes: Map<string, Box> }
  | {
      kind: "resize";
      handle: HandleId;
      startCanvas: Point;
      startGroup: Box;
      startBoxes: Map<string, Box>;
      localTransform?: GeometryMatrix;
    }
  | {
      kind: "create";
      tool: CreateTool;
      startCanvas: Point;
      current: Point;
      shiftKey: boolean;
      altKey: boolean;
      startEndpoint?: ConnectorEndpoint;
    }
  | { kind: "marquee"; startCanvas: Point; current: Point; additive: boolean }
  | { kind: "pen-anchor"; anchorIndex: number; anchorCanvas: Point }
  | { kind: "connector-end"; nodeId: string; end: "start" | "end" }
  | { kind: "vedit"; nodeId: string; part: VectorPart; lastCanvas: Point };

const CLICK_CREATE_MIN = 4;
/** Screen-pixel radius for grabbing anchors/handles and closing the pen path. */
const PART_HIT_PX = 8;

type GesturePreviewKind = "create" | "marquee" | "snap";

type TouchNavigation = {
  pointerIds: readonly [number, number];
  startViewport: Viewport;
  startCanvasCenter: Point;
  /** Null until a coincident pair first separates. */
  startDistance: number | null;
};

type TouchBaseline = {
  selection: readonly string[];
  pen: PenPath | null;
};

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function clonePenPath(path: PenPath | null): PenPath | null {
  if (!path) return null;
  return {
    closed: path.closed,
    anchors: path.anchors.map((anchor) => ({
      x: anchor.x,
      y: anchor.y,
      ...(anchor.handle ? { handle: { ...anchor.handle } } : {}),
    })),
  };
}

function toolKind(tool: Extract<CreateTool, "frame" | "text" | "rectangle">): "frame" | "text" | "rectangle" {
  return tool;
}

/**
 * The concrete tool-to-vector route used by pointer creation. Exported so the
 * routing contract can be tested without a DOM pointer harness.
 */
export function vectorPrimitiveCreateFromDrag(
  tool: Tool,
  start: Point,
  end: Point,
): { built: ReturnType<typeof buildPrimitiveFromDrag>; name: string; fills?: DesignFill[] } | null {
  if (!isVectorPrimitiveTool(tool)) return null;
  return {
    built: buildPrimitiveFromDrag(tool, start, end),
    name: primitiveDisplayName(tool),
    ...(tool === "line" ? {} : { fills: [{ kind: "solid", color: "#3b82f6" }] }),
  };
}

export function isVectorPrimitiveTool(tool: Tool): tool is PrimitiveTool {
  return isPrimitiveTool(tool);
}

/** Pure free-endpoint creation contract for the future Connector tool. */
export function connectorCreateFromDrag(start: Point, end: Point): DesignConnector {
  return {
    route: "straight",
    start: { x: start.x, y: start.y },
    end: { x: end.x, y: end.y },
  };
}

/** Build a connector from already-resolved pointer endpoints. */
export function connectorCreateFromEndpoints(start: ConnectorEndpoint, end: ConnectorEndpoint): DesignConnector {
  return { route: "straight", start, end };
}

/**
 * Pure shape-aware connector gesture contract. Hit ids are intentionally
 * supplied by the DOM adapter so tests and future accessibility input can use
 * the exact same target eligibility and inverse-rotation anchor rule.
 */
export function connectorCreateFromGesture(
  doc: DesignDocument,
  start: Point,
  end: Point,
  startHitId: string | null | undefined,
  endHitId: string | null | undefined,
): DesignConnector {
  return connectorCreateFromEndpoints(
    connectorEndpointForPoint(doc, start, startHitId),
    connectorEndpointForPoint(doc, end, endHitId),
  );
}

export function keepsShapeToolActive(tool: Tool): boolean {
  return tool === "rectangle" || tool === "ellipse" || tool === "polygon" ||
    tool === "triangle" || tool === "diamond" || tool === "pentagon" ||
    tool === "hexagon" || tool === "star" || tool === "arrow";
}

/** Middle drag and held-Space left drag are viewport-only gestures. */
export function shouldBeginCanvasPan(button: number, spacePanning: boolean): boolean {
  return button === 1 || (button === 0 && spacePanning);
}

/** Interaction-owned previews survive ordinary scene/selection re-renders. */
function createGestureOverlay(svg: SVGSVGElement): SVGGElement {
  const overlay = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.classList.add("design-gesture-overlay");
  overlay.setAttribute("pointer-events", "none");
  svg.appendChild(overlay);
  return overlay;
}

export function attachCanvasInteractions(deps: InteractionDeps): () => void {
  const { svg, store } = deps;
  let drag: DragState | null = null;
  let activePointerId: number | null = null;
  const touchPoints = new Map<number, Point>();
  let touchNavigation: TouchNavigation | null = null;
  let touchBaseline: TouchBaseline | null = null;
  const gestureOverlay = createGestureOverlay(svg);

  const clearGesturePreview = (): void => {
    while (gestureOverlay.firstChild) gestureOverlay.removeChild(gestureOverlay.firstChild);
  };

  const renderGesturePreview = (box: Box, kind: GesturePreviewKind, guides: readonly SnapGuide[] = []): void => {
    clearGesturePreview();
    const topLeft = canvasToScreen(deps.getViewport(), { x: box.x, y: box.y });
    const bottomRight = canvasToScreen(deps.getViewport(), { x: box.x + box.width, y: box.y + box.height });
    if (kind !== "snap") {
      const preview = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
      preview.dataset["gesturePreview"] = kind;
      preview.setAttribute("x", String(topLeft.x));
      preview.setAttribute("y", String(topLeft.y));
      preview.setAttribute("width", String(Math.max(0, bottomRight.x - topLeft.x)));
      preview.setAttribute("height", String(Math.max(0, bottomRight.y - topLeft.y)));
      preview.setAttribute("fill", kind === "marquee" ? "rgba(37, 99, 235, 0.12)" : "none");
      preview.setAttribute("stroke", "#2563eb");
      preview.setAttribute("stroke-width", "1.5");
      preview.setAttribute("stroke-dasharray", kind === "marquee" ? "4 3" : "6 3");
      gestureOverlay.appendChild(preview);
    }
    const rect = svg.getBoundingClientRect();
    for (const guide of guides) {
      const line = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "line");
      const point = canvasToScreen(deps.getViewport(), { x: guide.value, y: guide.value });
      if (guide.axis === "x") {
        line.setAttribute("x1", String(point.x));
        line.setAttribute("x2", String(point.x));
        line.setAttribute("y1", "0");
        line.setAttribute("y2", String(rect.height));
      } else {
        line.setAttribute("x1", "0");
        line.setAttribute("x2", String(rect.width));
        line.setAttribute("y1", String(point.y));
        line.setAttribute("y2", String(point.y));
      }
      line.dataset["gestureGuide"] = guide.axis;
      line.setAttribute("stroke", "#2563eb");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "3 3");
      gestureOverlay.appendChild(line);
    }
  };

  const screenPoint = (event: PointerEvent | WheelEvent): Point => {
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const canvasPoint = (event: PointerEvent | WheelEvent): Point =>
    screenToCanvas(deps.getViewport(), screenPoint(event));

  const boxOf = (id: string): Box | null => {
    const node = store.getDocument().nodes[id];
    if (!node || node.connector) return null;
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  };

  const onPenDown = (start: Point): void => {
    const path = deps.getPen() ?? emptyPenPath();
    const tol = PART_HIT_PX / deps.getViewport().scale;
    // Clicking the first anchor closes and finishes the path.
    if (path.anchors.length >= 2 && nearFirstAnchor(path, start.x, start.y, tol)) {
      deps.commitPen({ anchors: path.anchors, closed: true });
      deps.setPen(null, null);
      return;
    }
    const anchors = [...path.anchors, { x: start.x, y: start.y }];
    deps.setPen({ anchors, closed: false }, start);
    drag = { kind: "pen-anchor", anchorIndex: anchors.length - 1, anchorCanvas: start };
  };

  const beginTouchNavigation = (): void => {
    const entries = [...touchPoints.entries()].slice(0, 2);
    if (entries.length !== 2) return;
    const [first, second] = entries;
    if (!first || !second) return;
    const startCenter = midpoint(first[1], second[1]);
    touchNavigation = {
      pointerIds: [first[0], second[0]],
      startViewport: deps.getViewport(),
      startCanvasCenter: screenToCanvas(deps.getViewport(), startCenter),
      // A coincident pair can pan but has no scale baseline. Rebaseline only
      // once it separates, avoiding an arbitrary denominator and zoom jump.
      startDistance: distance(first[1], second[1]) || null,
    };
  };

  const updateTouchNavigation = (): void => {
    if (!touchNavigation) return;
    const [firstId, secondId] = touchNavigation.pointerIds;
    const first = touchPoints.get(firstId);
    const second = touchPoints.get(secondId);
    if (!first || !second) return;
    const center = midpoint(first, second);
    const currentDistance = distance(first, second);
    if (touchNavigation.startDistance === null) {
      // Continue an unzoomed pan while the touches coincide. On their first
      // separation, pan to the current center and use that exact geometry as
      // the baseline for subsequent scale changes.
      const scale = touchNavigation.startViewport.scale;
      const viewport = {
        scale,
        tx: center.x - touchNavigation.startCanvasCenter.x * scale,
        ty: center.y - touchNavigation.startCanvasCenter.y * scale,
      };
      deps.setViewport(viewport);
      if (currentDistance > 0) {
        touchNavigation = {
          ...touchNavigation,
          startViewport: viewport,
          startCanvasCenter: screenToCanvas(viewport, center),
          startDistance: currentDistance,
        };
      }
      return;
    }
    const scale = clampScale(
      touchNavigation.startViewport.scale * currentDistance / touchNavigation.startDistance,
    );
    deps.setViewport({
      scale,
      tx: center.x - touchNavigation.startCanvasCenter.x * scale,
      ty: center.y - touchNavigation.startCanvasCenter.y * scale,
    });
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as Element | null;
    const start = canvasPoint(event);
    if (event.pointerType === "touch") {
      if (touchPoints.size === 0) {
        touchBaseline = {
          selection: [...store.getState().selection],
          pen: clonePenPath(deps.getPen()),
        };
      }
      touchPoints.set(event.pointerId, screenPoint(event));
      svg.setPointerCapture(event.pointerId);
      if (touchPoints.size >= 2) {
        // Navigation takes precedence over a one-finger create/move/marquee
        // preview. Cancel it before changing the viewport so it cannot become
        // a durable document mutation when either touch later lifts.
        if (!touchNavigation) {
          cancelDrag(true);
          activePointerId = null;
          beginTouchNavigation();
        }
        return;
      }
    }
    activePointerId = event.pointerId;
    if (event.pointerType !== "touch") svg.setPointerCapture(event.pointerId);

    // Middle-button and held Space pan before a creation/select tool can act.
    const tool = deps.getTool();

    if (shouldBeginCanvasPan(event.button, deps.getSpacePanning?.() === true)) {
      drag = { kind: "pan", lastScreen: screenPoint(event) };
      return;
    }

    if (tool === "pen") {
      onPenDown(start);
      return;
    }

    if (tool !== "select") {
      const hitId = tool === "connector"
        ? hitTest(store.getDocument(), store.getState().activePageId, start, PART_HIT_PX / deps.getViewport().scale)
        : null;
      drag = {
        kind: "create",
        tool,
        startCanvas: start,
        current: start,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ...(tool === "connector" ? { startEndpoint: connectorEndpointForPoint(store.getDocument(), start, hitId) } : {}),
      };
      store.clearSelection();
      return;
    }

    const connectorEnd = target?.closest<SVGElement>("[data-connector-end]")?.dataset["connectorEnd"];
    const currentDocument = store.getDocument();
    const selectedConnector = store.getState().selection.length === 1 ? currentDocument.nodes[store.getState().selection[0]!] : undefined;
    if ((connectorEnd === "start" || connectorEnd === "end")
      && selectedConnector?.connector
      && !isNodeEffectivelyHidden(currentDocument, selectedConnector)
      && !isNodeEffectivelyLocked(currentDocument, selectedConnector)) {
      store.beginTransient();
      drag = { kind: "connector-end", nodeId: selectedConnector.id, end: connectorEnd };
      return;
    }
    // Node-edit mode: grab an anchor/handle of the edited vector, else drop out.
    const editId = deps.getEditNodeId();
    if (editId) {
      const node = store.getDocument().nodes[editId];
      if (node
        && node.type === "vector"
        && !node.connector
        && node.vectorNetwork
        && !isNodeEffectivelyHidden(store.getDocument(), node)
        && !isNodeEffectivelyLocked(store.getDocument(), node)) {
        const tol = PART_HIT_PX / deps.getViewport().scale;
        const part = hitVectorNodePart(node, start, tol);
        if (part) {
          deps.onVectorPartSelected?.(part);
          store.beginTransient();
          drag = { kind: "vedit", nodeId: editId, part, lastCanvas: start };
          return;
        }
      }
      deps.setEditNodeId(null);
    }

    const handleId = target?.closest<SVGElement>("[data-handle]")?.dataset["handle"] as
      | HandleId
      | undefined;
    if (handleId && store.getState().selection.length >= 1) {
      const startBoxes = new Map<string, Box>();
      for (const id of editableSelectionIds(store.getDocument(), store.getState().selection)) {
        const box = boxOf(id);
        if (box) startBoxes.set(id, box);
      }
      const singleId = startBoxes.size === 1 ? [...startBoxes.keys()][0] : undefined;
      const single = singleId ? store.getDocument().nodes[singleId] : undefined;
      // Single-node handles are on its local geometry, not paint overflow or
      // the page-aligned visual bounds. Keep that same basis for the drag.
      const startGroup = single
        ? { x: single.x, y: single.y, width: single.width, height: single.height }
        : editableSelectionBounds(store.getDocument(), store.getState().selection);
      if (startGroup && startBoxes.size > 0) {
        store.beginTransient();
        drag = { kind: "resize", handle: handleId, startCanvas: start, startGroup, startBoxes,
          ...(single ? { localTransform: nodeTransformMatrix(single) } : {}),
        };
        return;
      }
    }

    // Prefer the DOM target's node; fall back to a geometric hit test with a
    // tolerance so clicking *near* a thin vector path still selects it.
    const domCandidateId = target?.closest<SVGElement>("[data-node-id]")?.dataset["nodeId"];
    const domCandidate = domCandidateId ? store.getDocument().nodes[domCandidateId] : undefined;
    const domNodeId = domCandidate
      && !isNodeEffectivelyHidden(store.getDocument(), domCandidate)
      && !isNodeEffectivelyLocked(store.getDocument(), domCandidate)
      ? domCandidateId
      : undefined;
    const nodeId =
      domNodeId ??
      hitTest(store.getDocument(), store.getState().activePageId, start, PART_HIT_PX / deps.getViewport().scale) ??
      undefined;
    if (nodeId) {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const alreadySelected = store.getState().selection.includes(nodeId);
      if (additive) {
        store.select(nodeId, "toggle");
      } else if (!alreadySelected) {
        store.select(nodeId, "replace");
      }
      const selection = store.getState().selection;
      if (selection.includes(nodeId)) {
        const startBoxes = new Map<string, Box>();
        for (const id of editableSelectionIds(store.getDocument(), selection)) {
          const box = boxOf(id);
          if (box) startBoxes.set(id, box);
        }
        store.beginTransient();
        const startGroup = editableSelectionBounds(store.getDocument(), selection);
        if (startGroup) drag = { kind: "move", startCanvas: start, startGroup, startBoxes };
      }
      return;
    }

    // Empty canvas drags select a region; Space/middle panning already took
    // precedence above, so selection no longer steals a viewport gesture.
    drag = { kind: "marquee", startCanvas: start, current: start, additive: event.shiftKey || event.metaKey || event.ctrlKey };
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch" && touchPoints.has(event.pointerId)) {
      touchPoints.set(event.pointerId, screenPoint(event));
      if (touchNavigation) {
        updateTouchNavigation();
        return;
      }
      // Once a pinch has ended, its remaining finger remains consumed until
      // it lifts. It must not revive a cancelled pen hover or document drag.
      if (!drag) return;
    }
    if (!drag) {
      // Pen hover: keep the rubber band tracking the cursor between clicks.
      if (deps.getTool() === "pen") {
        const path = deps.getPen();
        if (path && path.anchors.length > 0) deps.setPen(path, canvasPoint(event));
      }
      return;
    }
    if (event.pointerId !== activePointerId) return;

    if (drag.kind === "pen-anchor") {
      const cur = canvasPoint(event);
      const path = deps.getPen();
      if (!path) return;
      const idx = drag.anchorIndex;
      const anchorCanvas = drag.anchorCanvas;
      const anchors = path.anchors.map((a, i) =>
        i === idx ? { ...a, handle: { dx: cur.x - anchorCanvas.x, dy: cur.y - anchorCanvas.y } } : a,
      );
      deps.setPen({ anchors, closed: false }, cur);
      return;
    }

    if (drag.kind === "connector-end") {
      const point = canvasPoint(event);
      const doc = store.getDocument();
      const candidates = { ...doc, nodes: { ...doc.nodes, [drag.nodeId]: { ...doc.nodes[drag.nodeId]!, hidden: true } } };
      const hit = hitTest(candidates, store.getState().activePageId, point, PART_HIT_PX / deps.getViewport().scale);
      store.updateTransientConnector(drag.nodeId, { [drag.end]: connectorEndpointForPoint(doc, point, hit) });
      return;
    }
    if (drag.kind === "vedit") {
      const cur = canvasPoint(event);
      const node = store.getDocument().nodes[drag.nodeId];
      if (node && node.type === "vector" && node.vectorNetwork) {
        const dx = cur.x - drag.lastCanvas.x;
        const dy = cur.y - drag.lastCanvas.y;
        const { network, box } = applyVectorNodeDrag(node, drag.part, dx, dy);
        store.updateTransientVector(drag.nodeId, network, box);
      }
      drag.lastCanvas = cur;
      return;
    }

    if (drag.kind === "pan") {
      const now = screenPoint(event);
      deps.setViewport(panBy(deps.getViewport(), now.x - drag.lastScreen.x, now.y - drag.lastScreen.y));
      drag.lastScreen = now;
      return;
    }

    const current = canvasPoint(event);

    if (drag.kind === "marquee") {
      drag.current = current;
      renderGesturePreview(dragBox(drag.startCanvas, current, false), "marquee");
      return;
    }

    if (drag.kind === "move") {
      const dx = current.x - drag.startCanvas.x;
      const dy = current.y - drag.startCanvas.y;
      const snapped = snapBoxToPageObjects(
        store.getDocument(),
        store.getState().activePageId,
        moveBox(drag.startGroup, dx, dy),
        new Set(drag.startBoxes.keys()),
        deps.getViewport(),
      );
      store.transformTransient([...drag.startBoxes.keys()], boxAffineMatrix(drag.startGroup, snapped.box));
      renderGesturePreview(snapped.box, "snap", snapped.guides);
      return;
    }

    if (drag.kind === "resize") {
      const inverse = drag.localTransform ? inverseMatrix(drag.localTransform) : null;
      const localStart = inverse ? transformPoint(drag.startCanvas, inverse) : drag.startCanvas;
      const localCurrent = inverse ? transformPoint(current, inverse) : current;
      const dx = localCurrent.x - localStart.x;
      const dy = localCurrent.y - localStart.y;
      const transformed = drag.localTransform &&
        (drag.localTransform.a !== 1 || drag.localTransform.b !== 0 ||
          drag.localTransform.c !== 0 || drag.localTransform.d !== 1);
      const snapped = transformed
        ? snapTransformedResizeBoxToPageObjects(
          store.getDocument(), store.getState().activePageId, drag.handle,
          drag.startGroup, dx, dy, new Set(drag.startBoxes.keys()), deps.getViewport(),
          { centered: event.altKey, preserveAspect: event.shiftKey }, drag.localTransform!,
        )
        : snapResizeBoxToPageObjects(
        store.getDocument(),
        store.getState().activePageId,
        drag.handle,
        drag.startGroup,
        dx,
        dy,
        new Set(drag.startBoxes.keys()),
        deps.getViewport(),
        { centered: event.altKey, preserveAspect: event.shiftKey },
      );
      const localResize = boxAffineMatrix(drag.startGroup, snapped.box);
      const matrix = drag.localTransform && inverse
        ? multiplyMatrices(multiplyMatrices(drag.localTransform, localResize), inverse)
        : localResize;
      store.transformTransient([...drag.startBoxes.keys()], matrix);
      const preview = editableSelectionBounds(store.getDocument(), [...drag.startBoxes.keys()]);
      if (preview) renderGesturePreview(preview, "snap", snapped.guides);
      return;
    }

    // Creation tracks the constrained point, while Alt mirrors its actual
    // bounds about pointer-down for the visible rubber-band preview.
    const lineLike = drag.tool === "line" || drag.tool === "connector";
    const constrained = constrainDragPoint(drag.startCanvas, current, event.shiftKey, lineLike);
    drag.current = constrained;
    drag.shiftKey = event.shiftKey;
    drag.altKey = event.altKey;
    renderGesturePreview(dragBox(drag.startCanvas, constrained, event.altKey), "create");
  };

  const finishDrag = (): void => {
    if (!drag) return;
    if (drag.kind === "move" || drag.kind === "resize" || drag.kind === "vedit" || drag.kind === "connector-end") {
      store.endTransient();
    } else if (drag.kind === "create") {
      createFromDrag(drag);
    } else if (drag.kind === "marquee") {
      const matched = marqueeSelectionIds(
        store.getDocument(),
        store.getState().activePageId,
        dragBox(drag.startCanvas, drag.current, false),
      );
      store.setSelection(drag.additive ? [...new Set([...store.getState().selection, ...matched])] : matched);
    }
    // pen-anchor: nothing to commit here — the pen path lives in the mount and
    // is finalized on close (first-anchor click) or Enter/Escape.
    drag = null;
    clearGesturePreview();
  };

  const createFromDrag = (state: Extract<DragState, { kind: "create" }>): void => {
    const dx = state.current.x - state.startCanvas.x;
    const dy = state.current.y - state.startCanvas.y;
    const dragged = Math.abs(dx) >= CLICK_CREATE_MIN && Math.abs(dy) >= CLICK_CREATE_MIN;
    const centered = state.altKey && state.tool !== "connector";
    const endpoints = creationEndpoints(state.startCanvas, state.current, centered);
    const box = dragBox(state.startCanvas, state.current, centered);
    if (state.tool === "connector") {
      const endHitId = hitTest(
        store.getDocument(),
        store.getState().activePageId,
        state.current,
        PART_HIT_PX / deps.getViewport().scale,
      );
      const id = store.addConnector(connectorCreateFromEndpoints(
        state.startEndpoint ?? { x: state.startCanvas.x, y: state.startCanvas.y },
        connectorEndpointForPoint(store.getDocument(), state.current, endHitId),
      ));
      store.setSelection([id]);
      deps.setTool("select");
      return;
    }
    if (isVectorPrimitiveTool(state.tool)) {
      const vectorPrimitive = vectorPrimitiveCreateFromDrag(state.tool, endpoints.start, endpoints.end);
      if (!vectorPrimitive) return;
      const id = store.addVectorNode(vectorPrimitive.built, {
        name: vectorPrimitive.name,
        ...(vectorPrimitive.fills !== undefined ? { fills: vectorPrimitive.fills } : {}),
      });
      store.setSelection([id]);
      if (!keepsShapeToolActive(state.tool)) deps.setTool("select");
      return;
    }
    const kind = toolKind(state.tool);

    const opts: Parameters<DesignStore["addNode"]>[1] = { x: Math.round(box.x), y: Math.round(box.y) };
    if (dragged) {
      opts.width = Math.round(box.width);
      opts.height = Math.round(box.height);
    }
    if (state.tool === "text") {
      opts.text = "Text";
    }
    const id = store.addNode(kind, opts);
    store.setSelection([id]);
    if (!keepsShapeToolActive(state.tool)) deps.setTool("select");
    if (state.tool === "text") deps.onTextEdit(id);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      const wasNavigationPointer = touchNavigation?.pointerIds.includes(event.pointerId) ?? false;
      touchPoints.delete(event.pointerId);
      if (touchNavigation) {
        // Ignore an extra touch that never joined the two-finger pair. The
        // primary pair remains a stable pan/pinch until one of its members
        // ends or cancels.
        if (!wasNavigationPointer) return;
        touchNavigation = null;
        activePointerId = null;
        if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
        if (touchPoints.size === 0) touchBaseline = null;
        return;
      }
      if (touchPoints.size === 0) touchBaseline = null;
    }
    if (event.pointerId !== activePointerId) return;
    finishDrag();
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    activePointerId = null;
  };

  const cancelDrag = (preserveTouchPoints = false): void => {
    if (!drag && !deps.getPen() && !touchNavigation) return;
    // This is harmless when the active gesture did not open a transient; it
    // guarantees pointercancel/Escape never turn a provisional edit into one
    // durable undo step.
    store.cancelTransient();
    if (preserveTouchPoints && touchBaseline) {
      // The first touch may have selected another object or appended a pen
      // anchor before its companion arrived. A navigation gesture restores
      // exactly the state before that provisional touch.
      store.setSelection(touchBaseline.selection);
      deps.setPen(clonePenPath(touchBaseline.pen), null);
    } else if (drag?.kind === "pen-anchor" || deps.getTool() === "pen") {
      deps.setPen(null, null);
    }
    drag = null;
    touchNavigation = null;
    if (!preserveTouchPoints) {
      for (const pointerId of touchPoints.keys()) {
        if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
      }
      touchPoints.clear();
      touchBaseline = null;
    }
    clearGesturePreview();
    if (activePointerId !== null && svg.hasPointerCapture(activePointerId)) svg.releasePointerCapture(activePointerId);
    activePointerId = null;
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      const wasNavigationPointer = touchNavigation?.pointerIds.includes(event.pointerId) ?? false;
      touchPoints.delete(event.pointerId);
      if (touchNavigation) {
        if (!wasNavigationPointer) return;
        touchNavigation = null;
        activePointerId = null;
        if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
        if (touchPoints.size === 0) touchBaseline = null;
        return;
      }
      if (touchPoints.size === 0) touchBaseline = null;
    }
    if (event.pointerId !== activePointerId) return;
    cancelDrag();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || (!drag && !deps.getPen() && !touchNavigation)) return;
    event.preventDefault();
    cancelDrag();
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const viewport = deps.getViewport();
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.0025);
      deps.setViewport(zoomAt(viewport, factor, screenPoint(event)));
    } else {
      deps.setViewport(panBy(viewport, -event.deltaX, -event.deltaY));
    }
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (deps.getTool() === "pen") return;
    const start = screenToCanvas(deps.getViewport(), {
      x: event.clientX - svg.getBoundingClientRect().left,
      y: event.clientY - svg.getBoundingClientRect().top,
    });
    const hit = hitTest(
      store.getDocument(),
      store.getState().activePageId,
      start,
      PART_HIT_PX / deps.getViewport().scale,
    );
    if (!hit) {
      deps.setEditNodeId(null);
      return;
    }
    const node = store.getDocument().nodes[hit];
    if (!node
      || isNodeEffectivelyHidden(store.getDocument(), node)
      || isNodeEffectivelyLocked(store.getDocument(), node)) {
      deps.setEditNodeId(null);
      return;
    }
    if (node?.type === "text") {
      store.setSelection([hit]);
      deps.onTextEdit(hit);
    } else if (node?.type === "vector" && !node.connector) {
      // Enter node-edit mode: show anchors/handles for this vector.
      store.setSelection([hit]);
      deps.setEditNodeId(hit);
    } else if (node?.connector) {
      // Connector endpoints have their own metadata editor; never expose the
      // derived vector-network anchor editor as a second authority.
      deps.setEditNodeId(null);
    }
  };

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerCancel);
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("dblclick", onDoubleClick);
  svg.ownerDocument.addEventListener("keydown", onKeyDown);

  return () => {
    svg.removeEventListener("pointerdown", onPointerDown);
    svg.removeEventListener("pointermove", onPointerMove);
    svg.removeEventListener("pointerup", onPointerUp);
    svg.removeEventListener("pointercancel", onPointerCancel);
    svg.removeEventListener("wheel", onWheel);
    svg.removeEventListener("dblclick", onDoubleClick);
    svg.ownerDocument.removeEventListener("keydown", onKeyDown);
    gestureOverlay.remove();
  };
}
