import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createDefaultManifest, parseDesignHtml, renderSceneSvg, serializeDesignHtml } from "../design-document";
import { appendChild, createEmptyDocument, createNode, validateDesignDocument, type DesignBooleanOp, type DesignDocument } from "../scene-graph";
import type { VectorNetwork } from "../vector";
import { createCanvasRenderer } from "./render";
import { connectorGeometry } from "./connector";
import type { TextMeasurer } from "../text-layout";

const VIEWPORT = { scale: 1, tx: 0, ty: 0 };

function triangle(): VectorNetwork {
  return {
    vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 0 }, { id: "c", x: 15, y: 24 }],
    segments: [{ id: "ab", startVertexId: "a", endVertexId: "b" }, { id: "bc", startVertexId: "b", endVertexId: "c" }, { id: "ca", startVertexId: "c", endVertexId: "a" }],
    regions: [{ id: "face", vertexIds: ["a", "b", "c"] }],
  };
}

function representativeDocument(): DesignDocument {
  let doc = createEmptyDocument();
  const frame = createNode({ id: "frame", type: "frame", parentId: null, x: 10, y: 20, width: 100, height: 40, rotation: 30 });
  const rect = createNode({
    id: "rect", type: "rectangle", parentId: null, x: 150, y: 20, width: 60, height: 30,
    fills: [{ kind: "solid", color: "#fef3c7" }], stroke: { color: "#92400e", width: 2, cap: "round", join: "bevel", dash: [3, 2] },
  });
  const text = createNode({
    id: "text", type: "text", parentId: null, x: 230, y: 10, width: 100, height: 40,
    text: "First\nSecond", fontSize: 16, fontWeight: 700, textAlign: "center", color: "#123456",
  });
  const vector = createNode({
    id: "vector", type: "vector", parentId: null, x: 20, y: 100, width: 30, height: 24,
    vectorNetwork: triangle(), fills: [{ kind: "solid", color: "#22c55e" }],
    stroke: { color: "#14532d", width: 2, cap: "round", join: "round", dash: [4, 1] },
  });
  const nodes = { frame, rect, text, vector };
  doc = { ...doc, nodes };
  for (const id of Object.keys(nodes)) doc = appendChild(doc, null, id, "page-1");
  return doc;
}

function booleanDocument(op: DesignBooleanOp): DesignDocument {
  let doc = createEmptyDocument();
  const composite = createNode({
    id: "boolean", type: "group", parentId: null, x: 0, y: 0, width: 120, height: 80, booleanOp: op,
    fills: [{ kind: "solid", color: "#2563eb" }], stroke: { color: "#dc2626", width: 4 },
  });
  const a = createNode({ id: "a", type: "rectangle", parentId: "boolean", x: 0, y: 0, width: 80, height: 80 });
  const b = createNode({ id: "b", type: "rectangle", parentId: "boolean", x: 40, y: 0, width: 80, height: 80 });
  doc = { ...doc, nodes: { boolean: composite, a, b } };
  doc = appendChild(doc, null, "boolean", "page-1");
  doc = appendChild(doc, "boolean", "a");
  return appendChild(doc, "boolean", "b");
}

function renderLive(doc: DesignDocument, textMeasurer?: TextMeasurer | null): SVGSVGElement {
  const window = new Window();
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
  try {
    const renderer = createCanvasRenderer(textMeasurer);
    renderer.render(doc, "page-1", VIEWPORT, []);
    return renderer.svg;
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
  }
}

function renderLiveSelection(doc: DesignDocument, selection: string[], editNodeId?: string): SVGSVGElement {
  const window = new Window();
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
  try {
    const renderer = createCanvasRenderer();
    renderer.render(doc, "page-1", VIEWPORT, selection, editNodeId ? { editNodeId } : undefined);
    return renderer.svg;
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
  }
}

describe("live canvas / SVG export fidelity", () => {
  test("shares representative primitive paint, text, vector, and rotated geometry", () => {
    const doc = representativeDocument();
    const live = renderLive(doc);
    const exported = renderSceneSvg(doc, "page-1");

    const frame = live.querySelector('[data-node-id="frame"] rect')!;
    expect(frame.getAttribute("fill")).toBe("#ffffff");
    expect(frame.getAttribute("stroke")).toBe("#cbd5e1");
    const frameTransform = live.querySelector('[data-node-id="frame"] > g')?.getAttribute("transform");
    expect(frameTransform).toStartWith("matrix(");
    expect(exported).toContain(`transform="${frameTransform}"`);

    const rectangle = live.querySelector('[data-node-id="rect"] rect')!;
    expect(rectangle.getAttribute("fill")).toBe("#fef3c7");
    expect(rectangle.getAttribute("stroke-dasharray")).toBe("3 2");
    expect(exported).toContain('stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="3 2"');

    const lines = live.querySelectorAll('[data-node-id="text"] tspan');
    expect([...lines].map((line) => [line.getAttribute("x"), line.getAttribute("y"), line.textContent])).toEqual([
      ["280", "26", "First"], ["280", "46", "Second"],
    ]);
    expect(exported).toContain('<tspan x="280" y="26">First</tspan><tspan x="280" y="46">Second</tspan>');
    expect(exported).toContain('text-anchor="middle"');

    const vector = live.querySelector('[data-node-id="vector"] path')!;
    expect(vector.getAttribute("d")).toBe("M 0 0 L 30 0 L 15 24 Z");
    expect(vector.getAttribute("transform")).toBe("translate(20 100)");
    expect(vector.getAttribute("stroke-dasharray")).toBe("4 1");
    expect(exported).toContain('fill="#22c55e" stroke="#14532d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 1"><path transform="translate(20 100)" d="M 0 0 L 30 0 L 15 24 Z"/>');
  });

  test("keeps every boolean operation fill-only in both live and exported renderers", () => {
    for (const op of ["union", "subtract", "intersect", "exclude"] as const) {
      const doc = booleanDocument(op);
      expect(validateDesignDocument(doc).nodes["boolean"]?.childIds).toEqual(["a", "b"]);
      const live = renderLive(doc);
      const composite = live.querySelector('[data-node-id="boolean"]')!;
      expect(composite.querySelector('[stroke="#dc2626"]')).toBeNull();
      expect(composite.querySelector("path")?.getAttribute("stroke")).toBeNull();
      const exported = renderSceneSvg(doc, "page-1");
      expect(exported).not.toContain('stroke="#dc2626"');
      expect(exported).toContain('fill="#2563eb"');
      if (op === "subtract") expect(exported).toContain("<mask");
      if (op === "intersect" || op === "subtract" || op === "exclude") expect(exported).toContain("<mask");
      if (op === "union") expect(exported.match(/<path /g)).toHaveLength(2);
    }
  });

  test("keeps every right-aligned multiline export line on the live width anchor", () => {
    const text = createNode({
      id: "right", type: "text", parentId: null, x: 40, y: 20, width: 90, height: 40,
      text: "One\nTwo", fontSize: 12, textAlign: "right",
    });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { right: text } }, null, "right", "page-1");
    const live = renderLive(doc);
    expect([...live.querySelectorAll('[data-node-id="right"] tspan')].map((line) => line.getAttribute("x"))).toEqual(["130", "130"]);
    const exported = renderSceneSvg(doc, "page-1");
    expect(exported).toContain('text-anchor="end"');
    expect(exported).toContain('<tspan x="130" y="32">One</tspan><tspan x="130" y="47">Two</tspan>');
  });

  test("uses the same measured wrapping and line height in live and export", () => {
    const text = createNode({
      id: "wrapped",
      type: "text",
      parentId: null,
      x: 10,
      y: 20,
      width: 50,
      height: 20,
      text: "one two abcdef",
      fontSize: 10,
      lineHeight: 1.5,
      textWrap: true,
    });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { wrapped: text } }, null, "wrapped", "page-1");
    const measurer: TextMeasurer = (value) => Array.from(value).length * 10;
    const liveLines = [...renderLive(doc, measurer).querySelectorAll('[data-node-id="wrapped"] tspan')]
      .map((line) => [line.getAttribute("y"), line.textContent]);
    expect(liveLines).toEqual([["30", "one"], ["45", "two"], ["60", "abcde"], ["75", "f"]]);
    const exported = renderSceneSvg(doc, "page-1", { textMeasurer: measurer });
    expect(exported).toContain('<tspan x="10" y="30">one</tspan><tspan x="10" y="45">two</tspan><tspan x="10" y="60">abcde</tspan><tspan x="10" y="75">f</tspan>');
    expect(exported).toContain('viewBox="-22 -12 114 121.5"');
  });

  test("uses the same embedded-font layout without a browser measurement seam", () => {
    const text = createNode({
      id: "wrapped",
      type: "text",
      parentId: null,
      width: 70,
      height: 20,
      text: "Nautilo wraps exactly",
      fontSize: 14,
      fontWeight: 700,
      textWrap: true,
    });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { wrapped: text } }, null, "wrapped", "page-1");
    const live = renderLive(doc);
    expect([...live.querySelectorAll('[data-node-id="wrapped"] tspan')].map((line) => line.textContent))
      .toEqual(["Nautilo", "wraps", "exactly"]);
    expect(live.querySelector('[data-node-id="wrapped"] text')?.getAttribute("font-family")).toBe("Nautilo Noto Sans");
    expect(live.querySelector("style")?.textContent).toContain("data:font/ttf;base64,");
    const exported = renderSceneSvg(doc, "page-1");
    expect(exported).toContain('font-family="Nautilo Noto Sans" font-weight="700"');
    expect(exported).toContain("data:font/ttf;base64,");
  });

  test("applies the same geometric font stretch and elliptical corners live and in export", () => {
    const text = createNode({ id: "stretched", type: "text", parentId: null, x: 10, y: 20, width: 80, height: 20, text: "Wide", fontSize: 10, fontStretch: 1.5, textAlign: "center" });
    const rect = createNode({ id: "rounded", type: "rectangle", parentId: null, x: 0, y: 60, width: 40, height: 20, radius: 8, radiusY: 3 });
    let doc: DesignDocument = { ...createEmptyDocument(), nodes: { stretched: text, rounded: rect } };
    doc = appendChild(doc, null, "stretched", "page-1");
    doc = appendChild(doc, null, "rounded", "page-1");
    const live = renderLive(doc, (value) => value.length * 5);
    expect(live.querySelector('[data-node-id="stretched"] text')?.getAttribute("transform")).toBe("translate(50 0) scale(1.5 1) translate(-50 0)");
    expect(live.querySelector('[data-node-id="rounded"] rect')?.getAttribute("rx")).toBe("8");
    expect(live.querySelector('[data-node-id="rounded"] rect')?.getAttribute("ry")).toBe("3");
    const exported = renderSceneSvg(doc, "page-1", { textMeasurer: (value) => value.length * 5 });
    expect(exported).toContain('transform="translate(50 0) scale(1.5 1) translate(-50 0)"');
    expect(exported).toContain('rx="8" ry="3"');
  });

  test("expands the static preview viewBox for a rotated node's rendered bounds", () => {
    const node = createNode({ id: "wide", type: "rectangle", parentId: null, width: 800, height: 10, rotation: 45 });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { wide: node } }, null, "wide", "page-1");
    // The rotated visual minimum is far above the old unrotated -32px padding.
    // It must be included in the viewBox rather than clipped.
    const values = renderSceneSvg(doc, "page-1").match(/viewBox="([^"]+)"/)?.[1]?.split(" ").map(Number);
    expect(values).toHaveLength(4);
    expect(values?.[0]).toBeCloseTo(81.622, 3);
    expect(values?.[1]).toBeCloseTo(-313.378, 3);
    expect(values?.[2]).toBeCloseTo(636.756, 3);
    expect(values?.[3]).toBeCloseTo(636.756, 3);
  });

  test("keeps connector caches out of generic resize and vector-edit overlays", () => {
    const base = createEmptyDocument();
    const shape = createNode({ id: "shape", type: "rectangle", parentId: null, x: 0, y: 0, width: 40, height: 40 });
    const connector = { route: "straight" as const, start: { x: 50, y: 20 }, end: { x: 150, y: 20 } };
    const geometry = connectorGeometry({ ...base, nodes: { shape } }, connector);
    const link = createNode({ id: "link", type: "vector", parentId: null, ...geometry, vectorNetwork: geometry.network, connector });
    const doc = appendChild(appendChild({ ...base, nodes: { shape, link } }, null, "shape", "page-1"), null, "link", "page-1");
    expect(renderLiveSelection(doc, ["link"]).querySelectorAll("[data-handle]").length).toBe(0);
    const endpoints = [...renderLiveSelection(doc, ["link"]).querySelectorAll("[data-connector-end]")];
    expect(endpoints.map((endpoint) => [
      endpoint.getAttribute("data-connector-end"),
      endpoint.getAttribute("cx"),
      endpoint.getAttribute("cy"),
    ])).toEqual([["start", "50", "20"], ["end", "150", "20"]]);
    const mixed = renderLiveSelection(doc, ["shape", "link"]);
    expect(mixed.querySelectorAll("[data-handle]").length).toBe(8);
    expect(mixed.querySelectorAll("[data-connector-end]").length).toBe(0);
    expect(renderLiveSelection(doc, ["link"], "link").querySelectorAll(".design-vedit__anchor").length).toBe(0);
  });

  test("does not expose direct-edit handles through a locked or hidden ancestor", () => {
    const base = createEmptyDocument();
    const parent = createNode({ id: "parent", type: "frame", parentId: null, width: 200, height: 100, locked: true });
    const vector = createNode({ id: "vector", type: "vector", parentId: "parent", x: 10, y: 10, width: 30, height: 24, vectorNetwork: triangle() });
    const connector = createNode({
      id: "connector", type: "vector", parentId: "parent", x: 60, y: 20, width: 80, height: 0,
      vectorNetwork: { vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 80, y: 0 }], segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }], regions: [] },
      connector: { route: "straight", start: { x: 60, y: 20 }, end: { x: 140, y: 20 } },
    });
    let doc: DesignDocument = { ...base, nodes: { parent, vector, connector } };
    doc = appendChild(doc, null, "parent", "page-1");
    doc = appendChild(doc, "parent", "vector");
    doc = appendChild(doc, "parent", "connector");

    const vectorOverlay = renderLiveSelection(doc, ["vector"], "vector");
    expect(vectorOverlay.querySelectorAll(".design-vedit__anchor")).toHaveLength(0);
    expect(vectorOverlay.querySelectorAll("[data-handle]")).toHaveLength(0);
    expect(renderLiveSelection(doc, ["connector"]).querySelectorAll("[data-connector-end]")).toHaveLength(0);

    const hiddenDoc = { ...doc, nodes: { ...doc.nodes, parent: { ...doc.nodes["parent"]!, locked: false, hidden: true } } };
    expect(renderLiveSelection(hiddenDoc, ["vector"], "vector").querySelector(".design-selection__outline")).toBeNull();
  });

  test("keeps an explicitly stroke-off connector invisible through live render, export, and reopen", () => {
    const connector = createNode({
      id: "connector",
      type: "vector",
      parentId: null,
      vectorNetwork: {
        vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 80, y: 30 }],
        segments: [{ id: "segment", startVertexId: "a", endVertexId: "b" }],
        regions: [],
      },
      connector: { route: "straight", start: { x: 10, y: 20 }, end: { x: 90, y: 50 } },
    });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { connector } }, null, "connector", "page-1");
    const live = renderLive(doc);
    expect(live.querySelector('[data-node-id="connector"] path')?.getAttribute("stroke")).toBeNull();
    const exported = renderSceneSvg(doc, "page-1");
    expect(exported).not.toContain("stroke=");
    const reopened = parseDesignHtml(serializeDesignHtml(createDefaultManifest(), doc));
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.document.scene.nodes["connector"]?.stroke).toBeUndefined();
    expect(renderSceneSvg(reopened.document.scene, "page-1")).not.toContain("stroke=");
  });

  test("inherits opacity and visibility without inheriting a parent's spatial transform", () => {
    const frame = { ...createNode({ id: "frame", type: "frame", parentId: null, x: 100, y: 100, width: 100, height: 100, rotation: 90, opacity: 0.5 }), childIds: ["child", "hidden"] };
    const child = createNode({ id: "child", type: "rectangle", parentId: "frame", x: 120, y: 110, width: 20, height: 10, rotation: 15, opacity: 0.5 });
    const hidden = createNode({ id: "hidden", type: "rectangle", parentId: "frame", x: 400, y: 400, width: 40, height: 40, hidden: true });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { frame, child, hidden } }, null, "frame", "page-1");
    const live = renderLive(doc);
    const liveFrame = live.querySelector('[data-node-id="frame"]')!;
    const liveChild = live.querySelector('[data-node-id="child"]')!;
    expect(liveFrame.getAttribute("opacity")).toBe("0.5");
    expect(liveChild.getAttribute("opacity")).toBe("0.5");
    expect(liveFrame.getAttribute("transform")).toBeNull();
    expect(liveFrame.querySelector(':scope > g')?.getAttribute("transform")).toStartWith("matrix(");
    expect(live.querySelector('[data-node-id="hidden"]')).toBeNull();

    const exported = renderSceneSvg(doc, "page-1");
    expect(exported.match(/opacity="0.5"/g)).toHaveLength(2);
    expect(exported).not.toContain('x="400"');
    expect(exported).toContain('<rect x="120" y="110" width="20" height="10"');
  });

  test("draws rotated selection and vector anchors at transformed positions", () => {
    const vector = createNode({
      id: "rotated",
      type: "vector",
      parentId: null,
      x: 0,
      y: 0,
      width: 30,
      height: 24,
      rotation: 90,
      vectorNetwork: triangle(),
    });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { rotated: vector } }, null, "rotated", "page-1");
    const selection = renderLiveSelection(doc, ["rotated"]);
    expect(selection.querySelector(".design-selection__outline")?.tagName.toLowerCase()).toBe("polygon");
    const edit = renderLiveSelection(doc, ["rotated"], "rotated");
    const anchor = edit.querySelector('.design-vedit__anchor[data-vvertex="a"]')!;
    expect(Number(anchor.getAttribute("x"))).toBeCloseTo(23);
    expect(Number(anchor.getAttribute("y"))).toBeCloseTo(-7);
  });

  test("exports a chosen node scope with descendant overflow bounds", () => {
    const frame = { ...createNode({ id: "frame", type: "frame", parentId: null, x: 0, y: 0, width: 10, height: 10 }), childIds: ["overflow"] };
    const overflow = createNode({ id: "overflow", type: "rectangle", parentId: "frame", x: 100, y: 50, width: 20, height: 20 });
    const other = createNode({ id: "other", type: "rectangle", parentId: null, x: 1000, y: 1000, width: 10, height: 10 });
    const base = createEmptyDocument();
    let doc: DesignDocument = { ...base, pages: [...base.pages, { id: "page-2", name: "Page 2", children: [] }], nodes: { frame, overflow, other } };
    doc = appendChild(doc, null, "frame", "page-1");
    doc = appendChild(doc, null, "other", "page-2");
    const exported = renderSceneSvg(doc, "page-1", { nodeIds: ["frame"] });
    expect(exported).toContain('viewBox="-32.5 -32.5 184.5 134.5"');
    expect(exported).not.toContain('x="1000"');
    expect(renderSceneSvg(doc, "page-1", { nodeIds: ["frame", "frame", "overflow"] }).match(/x="100"/g)).toHaveLength(1);
    expect(() => renderSceneSvg(doc, "page-1", { nodeIds: ["missing"] })).toThrow("unknown node missing");
    expect(() => renderSceneSvg(doc, "page-1", { nodeIds: ["other"] })).toThrow("from page page-1");
  });
});
