import type { ImagePreview } from "../image-assets";
/**
 * Renders the scene graph into live SVG DOM and draws the selection overlay
 * (bounding box + resize handles). Node geometry comes straight from the model
 * (absolute x/y/width/height); this module only maps those values onto SVG
 * attributes and never stores editor state as markup. All nodes are drawn in a
 * single scaled/translated group (coordinates are absolute), which keeps the
 * paint order identical to hit testing (see selection.ts).
 */

import { type DesignDocument, type DesignNode } from "../scene-graph";
import { dashArrayToString, pathDataFromVectorNetwork } from "../vector";
import { nodePaint } from "../render-style";
import {
  buildExactBooleanComposition,
  type BooleanSvgNode,
} from "../boolean-composition";
import { matrixToSvgTransform, nodeCorners, nodeLocalToDocument, nodeTransformMatrix } from "../geometry";
import {
  editableSelectionBounds,
  editableSelectionIds,
  isNodeEffectivelyHidden,
  isNodeEffectivelyLocked,
  selectionBounds,
} from "./selection";
import { canvasToScreen, type Point, type Viewport } from "./viewport";
import { HANDLE_IDS, handlePoint, type Box } from "./handles";
import { penPathToNetwork, type PenPath } from "./pen";
import { designBundledFontFaceCss } from "../bundled-fonts";
import { bundledFontTextByWeight, layoutTextNode, textRenderStyle, type TextMeasurer } from "../text-layout";
import { resolveConnectorEndpoint } from "./connector";

const SVG_NS = "http://www.w3.org/2000/svg";
const HANDLE_SIZE = 9;
const ANCHOR_SIZE = 8;
const CONTROL_RADIUS = 4;

/** In-progress pen preview (canvas coords) + the live cursor for the rubber band. */
export type PenPreview = { path: PenPath; cursor: Point | null };

/** Extra overlay state layered on top of the scene (node-edit + pen preview). */
export type OverlayState = {
  imagePreviews?: ReadonlyMap<string, ImagePreview>;
  editNodeId?: string | null;
  pen?: PenPreview | null;
};

export type CanvasRenderer = {
  svg: SVGSVGElement;
  render: (
    doc: DesignDocument,
    pageId: string,
    viewport: Viewport,
    selection: readonly string[],
    overlay?: OverlayState,
  ) => void;
};

function el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function setAttrs(node: SVGElement, attrs: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, typeof value === "number" ? String(value) : value);
  }
}

function applyStrokeAttributes(element: SVGElement, stroke: ReturnType<typeof nodePaint>["stroke"]): void {
  if (!stroke) return;
  element.setAttribute("stroke", stroke.color);
  element.setAttribute("stroke-width", String(stroke.width));
  if (stroke.cap) element.setAttribute("stroke-linecap", stroke.cap);
  if (stroke.join) element.setAttribute("stroke-linejoin", stroke.join);
  if (stroke.dash) {
    const dash = dashArrayToString(stroke.dash);
    if (dash) element.setAttribute("stroke-dasharray", dash);
  }
}

function booleanNodeDom(node: BooleanSvgNode): SVGElement {
  if (node.kind === "path") {
    const path = el("path");
    path.setAttribute("d", node.pathData);
    return path;
  }
  if (node.kind === "use") {
    const use = el("use");
    use.setAttribute("href", `#${node.id}`);
    return use;
  }
  const group = el("g");
  if (node.maskId) group.setAttribute("mask", `url(#${node.maskId})`);
  if (node.fill) group.setAttribute("fill", node.fill);
  for (const child of node.children) group.appendChild(booleanNodeDom(child));
  return group;
}

function appendExactBooleanDom(parent: SVGGElement, doc: DesignDocument, node: DesignNode): void {
  const result = buildExactBooleanComposition(doc, node);
  if (!result.ok) {
    parent.dataset["booleanError"] = result.reason;
    const title = el("title");
    title.textContent = result.reason;
    parent.appendChild(title);
    return;
  }
  if (result.composition.defs.length > 0) {
    const defs = el("defs");
    for (const def of result.composition.defs) {
      if (def.kind === "shape") {
        const shape = el("g");
        shape.setAttribute("id", def.id);
        shape.appendChild(booleanNodeDom(def.content));
        defs.appendChild(shape);
        continue;
      }
      const mask = el("mask");
      setAttrs(mask, {
        id: def.id,
        maskUnits: "userSpaceOnUse",
        x: def.bounds.minX,
        y: def.bounds.minY,
        width: Math.max(1, def.bounds.maxX - def.bounds.minX),
        height: Math.max(1, def.bounds.maxY - def.bounds.minY),
      });
      mask.appendChild(booleanNodeDom(def.content));
      defs.appendChild(mask);
    }
    parent.appendChild(defs);
  }
  parent.appendChild(booleanNodeDom(result.composition.body));
}

function renderNodeElement(node: DesignNode, doc: DesignDocument, textMeasurer?: TextMeasurer | null, imagePreviews?: ReadonlyMap<string, ImagePreview>): SVGElement {
  const group = el("g");
  group.dataset["nodeId"] = node.id;
  if (node.opacity !== undefined && node.opacity !== 1) {
    group.setAttribute("opacity", String(node.opacity));
  }
  const ownGeometry = el("g");
  if ((node.rotation || node.skewX || node.flipX) && node.booleanOp === undefined) {
    ownGeometry.setAttribute(
      "transform",
      matrixToSvgTransform(nodeTransformMatrix(node)),
    );
  }

  const paint = nodePaint(node);

  // Boolean operands already carry absolute document geometry. The composition
  // applies result paint once and never inherits a container transform.
  if (node.booleanOp !== undefined) {
    ownGeometry.setAttribute("fill", paint.fill ?? "none");
    appendExactBooleanDom(ownGeometry, doc, node);
    group.appendChild(ownGeometry);
    return group;
  }

  if (node.type === "text") {
    const text = el("text");
    const font = textRenderStyle(node);
    const fontSize = font.fontSize;
    setAttrs(text, {
      x: node.x,
      y: node.y,
      "font-size": fontSize,
      "font-family": font.fontFamily,
      fill: node.color ?? "#0f172a",
      "text-anchor":
        node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start",
    });
    if (node.textWrap || node.fontWeight !== undefined) text.setAttribute("font-weight", String(font.fontWeight));
    const anchorX =
      node.textAlign === "center"
        ? node.x + node.width / 2
        : node.textAlign === "right"
          ? node.x + node.width
          : node.x;
    const layout = layoutTextNode(node, textMeasurer);
    const fontStretch = node.fontStretch ?? 1;
    if (fontStretch !== 1) {
      text.setAttribute("transform", `translate(${anchorX} 0) scale(${fontStretch} 1) translate(${-anchorX} 0)`);
    }
    layout.lines.forEach((line, i) => {
      const tspan = el("tspan");
      setAttrs(tspan, { x: anchorX, y: node.y + fontSize + i * layout.lineHeight });
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    ownGeometry.appendChild(text);
  }

  if (node.type === "image") {
    const image = el("image");
    setAttrs(image, {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      preserveAspectRatio: "xMidYMid meet",
    });
    const preview = node.assetRef ? imagePreviews?.get(node.assetRef) : undefined;
    const href = node.assetRef ? (preview?.status === "ready" ? preview.dataUrl : null) : node.src;
    if (href) {
      image.setAttribute("href", href);
      ownGeometry.appendChild(image);
    } else {
      group.dataset["imageStatus"] = preview?.status ?? "loading";
      const box = el("rect");
      setAttrs(box, { x: node.x, y: node.y, width: node.width, height: node.height, fill: "#e2e8f0", stroke: "#64748b" });
      const title = el("title");
      title.textContent = preview?.status === "failed" ? preview.message : "Loading image";
      const label = el("text");
      setAttrs(label, { x: node.x + 8, y: node.y + 20, fill: "#334155", "font-size": 12 });
      label.textContent = preview?.status === "failed" ? "Image unavailable" : "Loading image…";
      ownGeometry.append(box, title, label);
    }
  }

  if (node.type === "frame" || node.type === "rectangle") {
    const rect = el("rect");
    setAttrs(rect, { x: node.x, y: node.y, width: node.width, height: node.height });
    if (node.radius) {
      setAttrs(rect, { rx: node.radius, ry: node.radiusY ?? node.radius });
    }
    rect.setAttribute("fill", paint.fill ?? "none");
    applyStrokeAttributes(rect, paint.stroke);
    ownGeometry.appendChild(rect);
  }

  if (node.type === "vector" && (node.vectorNetwork || node.vectorPath)) {
    const path = el("path");
    // The network is local to the node origin; place it with a translate so the
    // node's absolute x/y (moved via drag) positions the whole path.
    path.setAttribute("transform", `translate(${node.x} ${node.y})`);
    path.setAttribute("d", node.vectorNetwork ? pathDataFromVectorNetwork(node.vectorNetwork) : node.vectorPath!);
    path.setAttribute("fill", paint.fill ?? "none");
    applyStrokeAttributes(path, paint.stroke);
    ownGeometry.appendChild(path);
  }

  group.appendChild(ownGeometry);
  for (const childId of node.childIds) {
    const child = doc.nodes[childId];
    if (child && !child.hidden) {
      group.appendChild(renderNodeElement(child, doc, textMeasurer, imagePreviews));
    }
  }
  return group;
}

export function createCanvasRenderer(textMeasurer?: TextMeasurer | null): CanvasRenderer {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("design-canvas__svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");

  const fontStyle = el("style");
  svg.appendChild(fontStyle);
  const sceneGroup = el("g");
  sceneGroup.classList.add("design-canvas__scene");
  const overlayGroup = el("g");
  overlayGroup.classList.add("design-canvas__overlay");
  svg.appendChild(sceneGroup);
  svg.appendChild(overlayGroup);

  const render = (
    doc: DesignDocument,
    pageId: string,
    viewport: Viewport,
    selection: readonly string[],
    overlay?: OverlayState,
  ): void => {
    fontStyle.textContent = designBundledFontFaceCss(bundledFontTextByWeight(Object.values(doc.nodes)));
    sceneGroup.setAttribute(
      "transform",
      `translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`,
    );
    while (sceneGroup.firstChild) sceneGroup.removeChild(sceneGroup.firstChild);
    const page = doc.pages.find((candidate) => candidate.id === pageId);
    for (const id of page?.children ?? []) {
      const node = doc.nodes[id];
      if (!node || node.hidden) continue;
      sceneGroup.appendChild(renderNodeElement(node, doc, textMeasurer, overlay?.imagePreviews));
    }
    renderOverlay(overlayGroup, doc, viewport, selection, overlay, textMeasurer);
  };

  return { svg, render };
}

function renderOverlay(
  overlay: SVGGElement,
  doc: DesignDocument,
  viewport: Viewport,
  selection: readonly string[],
  state?: OverlayState,
  textMeasurer?: TextMeasurer | null,
): void {
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

  // Node-edit mode: draw anchors + control handles for the edited vector and
  // suppress the resize box (they'd fight for the same clicks).
  const editId = state?.editNodeId ?? null;
  const editNode = editId ? doc.nodes[editId] : undefined;
  const editingVector = editNode?.type === "vector"
    && !editNode.connector
    && editNode.vectorNetwork !== undefined
    && !isNodeEffectivelyHidden(doc, editNode)
    && !isNodeEffectivelyLocked(doc, editNode);
  if (editingVector) {
    renderVectorEditOverlay(overlay, editNode, viewport);
  }

  if (state?.pen) renderPenPreview(overlay, state.pen, viewport);

  const selectedConnector = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  if (selectedConnector?.connector
    && !isNodeEffectivelyHidden(doc, selectedConnector)
    && !isNodeEffectivelyLocked(doc, selectedConnector)) {
    for (const end of ["start", "end"] as const) {
      const endpoint = resolveConnectorEndpoint(doc, selectedConnector.connector[end]);
      const screen = canvasToScreen(viewport, endpoint);
      const handle = el("circle");
      setAttrs(handle, {
        cx: screen.x,
        cy: screen.y,
        r: CONTROL_RADIUS + 1,
        fill: "#ffffff",
        stroke: "#2563eb",
        "stroke-width": 1.5,
      });
      handle.classList.add("design-connector__endpoint");
      handle.dataset["connectorEnd"] = end;
      overlay.appendChild(handle);
    }
  }

  // In node-edit mode we skip the selection box entirely.
  if (editingVector) return;

  const bounds = selectionBounds(doc, selection, textMeasurer);
  if (!bounds) return;

  const singleNode = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  const outline = singleNode && (singleNode.rotation || singleNode.skewX || singleNode.flipX)
    ? el("polygon")
    : el("rect");
  if (outline.tagName.toLowerCase() === "polygon" && singleNode) {
    outline.setAttribute("points", nodeCorners(singleNode)
      .map((point) => canvasToScreen(viewport, point))
      .map((point) => `${point.x},${point.y}`)
      .join(" "));
  } else {
    const topLeft = canvasToScreen(viewport, { x: bounds.x, y: bounds.y });
    const bottomRight = canvasToScreen(viewport, { x: bounds.x + bounds.width, y: bounds.y + bounds.height });
    setAttrs(outline, {
      x: topLeft.x,
      y: topLeft.y,
      width: Math.max(0, bottomRight.x - topLeft.x),
      height: Math.max(0, bottomRight.y - topLeft.y),
    });
  }
  setAttrs(outline, { fill: "none", stroke: "#2563eb", "stroke-width": 1.5 });
  outline.classList.add("design-selection__outline");
  overlay.appendChild(outline);

  // Resize handles operate on the selection bounding box (single node or the
  // group bbox of a multi-selection).
  const editableBounds = editableSelectionBounds(doc, selection, textMeasurer);
  if (!editableBounds) return;
  const box: Box = editableBounds;
  const editableIds = editableSelectionIds(doc, selection);
  const singleEditable = editableIds.length === 1 ? doc.nodes[editableIds[0]!] : undefined;
  for (const handleId of HANDLE_IDS) {
    const point = singleEditable
      ? nodeLocalToDocument(singleEditable, handlePoint({ x: 0, y: 0, width: singleEditable.width, height: singleEditable.height }, handleId))
      : handlePoint(box, handleId);
    const screen = canvasToScreen(viewport, point);
    const handle = el("rect");
    setAttrs(handle, {
      x: screen.x - HANDLE_SIZE / 2,
      y: screen.y - HANDLE_SIZE / 2,
      width: HANDLE_SIZE,
      height: HANDLE_SIZE,
      fill: "#ffffff",
      stroke: "#2563eb",
      "stroke-width": 1.5,
    });
    handle.classList.add("design-selection__handle");
    handle.dataset["handle"] = handleId;
    overlay.appendChild(handle);
  }
}

/**
 * Draw a vector node's anchors (squares) and control handles (line + circle) in
 * screen space. The network is local to the node origin, so each coordinate is
 * offset by (node.x, node.y) before mapping to screen. Elements are tagged with
 * data attributes; hit-testing itself is geometric (see interactions.ts).
 */
function renderVectorEditOverlay(overlay: SVGGElement, node: DesignNode, viewport: Viewport): void {
  const net = node.vectorNetwork;
  if (!net) return;
  const vertexById = new Map(net.vertices.map((v) => [v.id, v]));
  const toScreen = (lx: number, ly: number): Point =>
    canvasToScreen(viewport, nodeLocalToDocument(node, { x: lx, y: ly }));

  for (const seg of net.segments) {
    const drawHandle = (hx: number, hy: number, anchorId: string, end: "start" | "end"): void => {
      const anchor = vertexById.get(anchorId);
      if (!anchor) return;
      const a = toScreen(anchor.x, anchor.y);
      const h = toScreen(hx, hy);
      const line = el("line");
      setAttrs(line, { x1: a.x, y1: a.y, x2: h.x, y2: h.y, stroke: "#2563eb", "stroke-width": 1 });
      line.classList.add("design-vedit__handle-line");
      overlay.appendChild(line);
      const dot = el("circle");
      setAttrs(dot, {
        cx: h.x,
        cy: h.y,
        r: CONTROL_RADIUS,
        fill: "#ffffff",
        stroke: "#2563eb",
        "stroke-width": 1.5,
      });
      dot.classList.add("design-vedit__handle");
      dot.dataset["vseg"] = seg.id;
      dot.dataset["vend"] = end;
      overlay.appendChild(dot);
    };
    if (seg.startHandle) drawHandle(seg.startHandle.x, seg.startHandle.y, seg.startVertexId, "start");
    if (seg.endHandle) drawHandle(seg.endHandle.x, seg.endHandle.y, seg.endVertexId, "end");
  }

  for (const v of net.vertices) {
    const p = toScreen(v.x, v.y);
    const square = el("rect");
    setAttrs(square, {
      x: p.x - ANCHOR_SIZE / 2,
      y: p.y - ANCHOR_SIZE / 2,
      width: ANCHOR_SIZE,
      height: ANCHOR_SIZE,
      fill: "#ffffff",
      stroke: "#2563eb",
      "stroke-width": 1.5,
    });
    square.classList.add("design-vedit__anchor");
    square.dataset["vvertex"] = v.id;
    overlay.appendChild(square);
  }
}

/**
 * Draw the in-progress pen path: committed segments (canvas-space path inside a
 * viewport-transformed group), anchor squares (screen space), and a dashed
 * rubber band from the last anchor to the cursor.
 */
function renderPenPreview(overlay: SVGGElement, preview: PenPreview, viewport: Viewport): void {
  const { path, cursor } = preview;
  if (path.anchors.length === 0) return;

  if (path.anchors.length >= 2) {
    const scene = el("g");
    scene.setAttribute("transform", `translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`);
    const line = el("path");
    line.setAttribute("d", pathDataFromVectorNetwork(penPathToNetwork(path)));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#2563eb");
    line.setAttribute("stroke-width", String(1.5 / viewport.scale));
    scene.appendChild(line);
    overlay.appendChild(scene);
  }

  const last = path.anchors[path.anchors.length - 1]!;
  if (cursor) {
    const a = canvasToScreen(viewport, { x: last.x, y: last.y });
    const c = canvasToScreen(viewport, cursor);
    const band = el("line");
    setAttrs(band, {
      x1: a.x,
      y1: a.y,
      x2: c.x,
      y2: c.y,
      stroke: "#2563eb",
      "stroke-width": 1,
      "stroke-dasharray": "4 3",
    });
    band.classList.add("design-pen__band");
    overlay.appendChild(band);
  }

  path.anchors.forEach((anchor, i) => {
    const p = canvasToScreen(viewport, { x: anchor.x, y: anchor.y });
    const square = el("rect");
    setAttrs(square, {
      x: p.x - ANCHOR_SIZE / 2,
      y: p.y - ANCHOR_SIZE / 2,
      width: ANCHOR_SIZE,
      height: ANCHOR_SIZE,
      fill: i === 0 ? "#2563eb" : "#ffffff",
      stroke: "#2563eb",
      "stroke-width": 1.5,
    });
    square.classList.add("design-pen__anchor");
    overlay.appendChild(square);
  });
}
