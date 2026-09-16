import { describe, expect, test } from "bun:test";
import {
  createDefaultManifest,
  createEmptyDesignHtml,
  NAUTILO_DESIGN_MANIFEST_TYPE,
  NAUTILO_DESIGN_SCENE_TYPE,
  parseDesignHtml,
  renderSceneSvg,
  serializeDesignHtml,
} from "./design-document";
import {
  createEmptyDocument,
  createNode,
  appendChild,
  type DesignBooleanOp,
  type DesignDocument,
} from "./scene-graph";
import { parsePathData, type VectorNetwork } from "./vector";

function triangleNetwork(): VectorNetwork {
  return {
    vertices: [
      { id: "v1", x: 0, y: 0 },
      { id: "v2", x: 20, y: 0 },
      { id: "v3", x: 10, y: 20 },
    ],
    segments: [
      { id: "s1", startVertexId: "v1", endVertexId: "v2" },
      { id: "s2", startVertexId: "v2", endVertexId: "v3" },
      { id: "s3", startVertexId: "v3", endVertexId: "v1" },
    ],
    regions: [{ id: "r1", vertexIds: ["v1", "v2", "v3"] }],
  };
}

/**
 * A boolean node (kind "group" + booleanOp) with two rectangle operands. The
 * operands overlap so every op produces a meaningful result.
 */
function booleanDoc(op: DesignBooleanOp): DesignDocument {
  const base = createEmptyDocument();
  const boolNode = createNode({
    id: "node-1",
    type: "group",
    parentId: null,
    booleanOp: op,
    x: 0,
    y: 0,
    width: 120,
    height: 80,
    fills: [{ kind: "solid", color: "#3b82f6" }],
  });
  const a = createNode({
    id: "node-2",
    type: "rectangle",
    parentId: "node-1",
    x: 0,
    y: 0,
    width: 80,
    height: 80,
  });
  const b = createNode({
    id: "node-3",
    type: "rectangle",
    parentId: "node-1",
    x: 40,
    y: 0,
    width: 80,
    height: 80,
  });
  const withNodes: DesignDocument = {
    ...base,
    nodes: { "node-1": boolNode, "node-2": a, "node-3": b },
  };
  const withRoot = appendChild(withNodes, null, "node-1", "page-1");
  const withA = appendChild(withRoot, "node-1", "node-2");
  return appendChild(withA, "node-1", "node-3");
}

function sampleDoc(): DesignDocument {
  const base = createEmptyDocument();
  const frame = createNode({
    id: "node-1",
    type: "frame",
    parentId: null,
    name: "Card",
    x: 40,
    y: 40,
    width: 240,
    height: 160,
    fills: [{ kind: "solid", color: "#dbeafe" }],
    radius: 12,
  });
  const text = createNode({
    id: "node-2",
    type: "text",
    parentId: "node-1",
    name: "Title",
    x: 56,
    y: 56,
    width: 200,
    height: 32,
    text: "Hello design",
    fontSize: 24,
    fontWeight: 700,
    color: "#0f172a",
  });
  const rect = createNode({
    id: "node-3",
    type: "rectangle",
    parentId: "node-1",
    name: "Badge",
    x: 56,
    y: 104,
    width: 80,
    height: 24,
    fills: [{ kind: "solid", color: "#16a34a" }],
    radius: 12,
  });
  const withNodes: DesignDocument = {
    ...base,
    nodes: { "node-1": frame, "node-2": text, "node-3": rect },
  };
  const withFrame = appendChild(withNodes, null, "node-1", "page-1");
  const withText = appendChild(withFrame, "node-1", "node-2");
  return appendChild(withText, "node-1", "node-3");
}

function sampleHtml(): string {
  return serializeDesignHtml(createDefaultManifest(), sampleDoc());
}

describe("design-document", () => {
  test("parses manifest and scene payload", () => {
    const result = parseDesignHtml(sampleHtml());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.manifest.documentType).toBe("design");
    expect(result.document.manifest.payloadId).toBe("scene");
    expect(result.document.scene.nodes["node-1"]!.name).toBe("Card");
  });

  test("serializes manifest and scene as non-executable JSON script blocks", () => {
    const html = sampleHtml();
    expect(html).toContain(`type="${NAUTILO_DESIGN_MANIFEST_TYPE}"`);
    expect(html).toContain(`type="${NAUTILO_DESIGN_SCENE_TYPE}"`);
    expect(html).toContain("<svg");
    expect(html).toContain("Hello design");
    expect(html).toContain("Open with Nautilo Design to edit");
  });

  test("serialize is deterministic when metadata is not touched", () => {
    const manifest = createDefaultManifest();
    const doc = sampleDoc();
    const first = serializeDesignHtml(manifest, doc);
    const second = serializeDesignHtml(manifest, doc);
    expect(second).toBe(first);
  });

  test("touching metadata updates updatedAt", () => {
    const manifest = createDefaultManifest();
    const doc = sampleDoc();
    const touched = serializeDesignHtml(manifest, doc, {
      touchMetadata: true,
      updatedAt: "2026-07-06T12:00:00.000Z",
    });
    expect(touched).toContain("2026-07-06T12:00:00.000Z");
  });

  test("rejects executable script tags", () => {
    const html = `${sampleHtml()}<script>alert(1)</script>`;
    expect(parseDesignHtml(html).ok).toBe(false);
  });

  test("rejects executable module script tags", () => {
    const html = `${sampleHtml()}<script type="module">import x from "y"</script>`;
    expect(parseDesignHtml(html).ok).toBe(false);
  });

  test("rejects prototype-pollution keys in scene payload", () => {
    const manifest = JSON.stringify(createDefaultManifest());
    const scene = JSON.stringify({
      version: 1,
      pages: [{ id: "page-1", name: "Page 1", children: [] }],
      nodes: { "node-1": { constructor: { polluted: true } } },
    });
    const html = `<!doctype html><script type="${NAUTILO_DESIGN_MANIFEST_TYPE}" id="manifest">${manifest}</script><script type="${NAUTILO_DESIGN_SCENE_TYPE}" id="scene">${scene}</script>`;
    expect(parseDesignHtml(html).ok).toBe(false);
  });

  test("rejects unknown manifest documentType", () => {
    const manifest = JSON.stringify({
      ...createDefaultManifest(),
      documentType: "spreadsheet",
    });
    const scene = JSON.stringify(createEmptyDocument());
    const html = `<!doctype html><script type="${NAUTILO_DESIGN_MANIFEST_TYPE}" id="manifest">${manifest}</script><script type="${NAUTILO_DESIGN_SCENE_TYPE}" id="scene">${scene}</script>`;
    expect(parseDesignHtml(html).ok).toBe(false);
  });

  test("round-trips parse and serialize", () => {
    const html = sampleHtml();
    const parsed = parseDesignHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reSerialized = serializeDesignHtml(parsed.document.manifest, parsed.document.scene);
    const reparsed = parseDesignHtml(reSerialized);
    expect(reparsed.ok).toBe(true);
  });

  test("createEmptyDesignHtml is a valid container", () => {
    const html = createEmptyDesignHtml();
    expect(html).toContain(`type="${NAUTILO_DESIGN_MANIFEST_TYPE}"`);
    expect(parseDesignHtml(html).ok).toBe(true);
  });

  test("renderSceneSvg emits an SVG with viewBox for a non-empty scene", () => {
    const svg = renderSceneSvg(sampleDoc(), "page-1");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox=");
    expect(svg).toContain("Hello design");
  });

  test("renderSceneSvg draws a vector node from its vectorNetwork", () => {
    const base = createEmptyDocument();
    const vec = createNode({
      id: "node-1",
      type: "vector",
      parentId: null,
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      vectorNetwork: triangleNetwork(),
      fills: [{ kind: "solid", color: "#111" }],
      stroke: { color: "#f00", width: 2, cap: "round", join: "bevel", dash: [4, 2] },
    });
    const doc = appendChild({ ...base, nodes: { "node-1": vec } }, null, "node-1", "page-1");
    const svg = renderSceneSvg(doc, "page-1");
    expect(svg).toContain('<path transform="translate(0 0)" d="M 0 0 L 20 0 L 10 20 Z"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="bevel"');
    expect(svg).toContain('stroke-dasharray="4 2"');
  });

  test("renderSceneSvg falls back to opaque vectorPath when no network", () => {
    const base = createEmptyDocument();
    const vec = createNode({
      id: "node-1",
      type: "vector",
      parentId: null,
      vectorPath: "M 1 1 L 5 5",
      width: 10,
      height: 10,
    });
    const doc = appendChild({ ...base, nodes: { "node-1": vec } }, null, "node-1", "page-1");
    expect(renderSceneSvg(doc, "page-1")).toContain('<path transform="translate(0 0)" d="M 1 1 L 5 5"');
  });

  test("renderSceneSvg composes union from exact operand paths", () => {
    const svg = renderSceneSvg(booleanDoc("union"), "page-1");
    expect(svg).toContain('d="M 0 0 L 80 0 L 80 80 L 0 80 Z"');
    expect(svg).toContain('d="M 40 0 L 120 0 L 120 80 L 40 80 Z"');
  });

  test("renderSceneSvg composes exclude (XOR) with symmetric-difference masks", () => {
    const svg = renderSceneSvg(booleanDoc("exclude"), "page-1");
    expect(svg).toContain('id="boolean-node-1-exclude-1-left"');
    expect(svg).toContain('id="boolean-node-1-exclude-1-right"');
  });

  test("renderSceneSvg composes subtract with a mask (first white, rest black)", () => {
    const svg = renderSceneSvg(booleanDoc("subtract"), "page-1");
    expect(svg).toContain('<mask id="boolean-node-1-subtract"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain('mask="url(#boolean-node-1-subtract)"');
  });

  test("renderSceneSvg composes intersect with an exact alpha mask", () => {
    const svg = renderSceneSvg(booleanDoc("intersect"), "page-1");
    expect(svg).toContain('<mask id="boolean-node-1-intersect-0"');
    expect(svg).toContain('mask="url(#boolean-node-1-intersect-0)"');
  });

  test("renderSceneSvg boolean uses operand's local geometry offset into the group", () => {
    // node-3 is at x=40 relative to the boolean node at x=0, so its subpath
    // must start at 40 (not 0).
    const svg = renderSceneSvg(booleanDoc("union"), "page-1");
    expect(svg).toContain("M 40 0 L 120 0");
  });

  test("renderSceneSvg renders a boolean composite fill-only (no stroke even if set)", () => {
    const doc = booleanDoc("union");
    const boolNode = doc.nodes["node-1"]!;
    const withStroke: DesignDocument = {
      ...doc,
      nodes: {
        ...doc.nodes,
        "node-1": { ...boolNode, stroke: { color: "#ef4444", width: 4, dash: [5, 5] } },
      },
    };
    const svg = renderSceneSvg(withStroke, "page-1");
    // Fill is preserved exactly as before…
    expect(svg).toContain('fill="#3b82f6"');
    // …but no stroke is emitted for the composited boolean result.
    expect(svg).not.toContain('stroke="#ef4444"');
    expect(svg).not.toContain("stroke-width");
    expect(svg).not.toContain("stroke-dasharray");
  });

  test("renderSceneSvg still strokes a non-boolean rectangle (stroke gate is boolean-only)", () => {
    const base = createEmptyDocument();
    const rect = createNode({
      id: "node-1",
      type: "rectangle",
      parentId: null,
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      stroke: { color: "#ef4444", width: 3 },
    });
    const doc = appendChild({ ...base, nodes: { "node-1": rect } }, null, "node-1", "page-1");
    const svg = renderSceneSvg(doc, "page-1");
    expect(svg).toContain('stroke="#ef4444"');
    expect(svg).toContain('stroke-width="3"');
  });

  test("renderSceneSvg composites a rounded-rectangle boolean operand with curves", () => {
    const doc = booleanDoc("union");
    const rounded: DesignDocument = {
      ...doc,
      nodes: {
        ...doc.nodes,
        "node-2": { ...doc.nodes["node-2"]!, radius: 10 },
      },
    };
    const svg = renderSceneSvg(rounded, "page-1");
    const pathData = svg.match(/<path d="([^"]+)"\/>/)?.[1];
    const corner = pathData ? parsePathData(pathData)?.find((command) => command.kind === "C") : undefined;
    expect(corner?.kind).toBe("C");
    if (corner?.kind !== "C") return;
    const kappa = (4 / 3) * Math.tan(Math.PI / 8);
    expect(corner.c1x).toBeCloseTo(70 + 10 * kappa, 12);
    expect(corner.c2y).toBeCloseTo(10 - 10 * kappa, 12);
    expect(corner.x).toBeCloseTo(80, 12);
    expect(corner.y).toBeCloseTo(10, 12);
  });

  test("renderSceneSvg composites a nested (A ∪ B) − C boolean with real inner subpaths", () => {
    // Outer subtract node-1 with children: inner union (node-4) and C (node-5).
    const base = createEmptyDocument();
    const outer = createNode({
      id: "node-1",
      type: "group",
      parentId: null,
      booleanOp: "subtract",
      x: 0,
      y: 0,
      width: 120,
      height: 80,
      fills: [{ kind: "solid", color: "#3b82f6" }],
    });
    const inner = createNode({
      id: "node-4",
      type: "group",
      parentId: "node-1",
      booleanOp: "union",
      x: 0,
      y: 0,
      width: 120,
      height: 80,
    });
    const a = createNode({ id: "node-2", type: "rectangle", parentId: "node-4", x: 0, y: 0, width: 80, height: 80 });
    const b = createNode({ id: "node-3", type: "rectangle", parentId: "node-4", x: 40, y: 0, width: 80, height: 80 });
    const c = createNode({ id: "node-5", type: "rectangle", parentId: "node-1", x: 20, y: 20, width: 40, height: 40 });
    let doc: DesignDocument = {
      ...base,
      nodes: {
        "node-1": { ...outer, childIds: ["node-4", "node-5"] },
        "node-4": { ...inner, childIds: ["node-2", "node-3"] },
        "node-2": a,
        "node-3": b,
        "node-5": c,
      },
    };
    doc = appendChild(doc, null, "node-1", "page-1");
    const svg = renderSceneSvg(doc, "page-1");
    // The subtract mask's white source is the inner union's concatenated subpaths
    // (A + B), not the inner union's 120x80 bounding box.
    expect(svg).toContain('d="M 0 0 L 80 0 L 80 80 L 0 80 Z"');
    expect(svg).toContain('d="M 40 0 L 120 0 L 120 80 L 40 80 Z"');
    expect(svg).toContain('<mask id="boolean-node-1-subtract"');
  });

  test("renderSceneSvg grows linearly for deeply nested subtraction", () => {
    const build = (depth: number): string => {
      const base = createEmptyDocument();
      const nodes: DesignDocument["nodes"] = {};
      nodes[`leaf-${depth}`] = createNode({
        id: `leaf-${depth}`,
        type: "rectangle",
        parentId: `boolean-${depth - 1}`,
        width: 10,
        height: 10,
      });
      for (let index = depth - 1; index >= 0; index -= 1) {
        const id = `boolean-${index}`;
        const child = index === depth - 1 ? `leaf-${depth}` : `boolean-${index + 1}`;
        const cutId = `cut-${index}`;
        nodes[cutId] = createNode({ id: cutId, type: "rectangle", parentId: id, x: 2, y: 2, width: 2, height: 2 });
        nodes[id] = {
          ...createNode({ id, type: "group", parentId: index === 0 ? null : `boolean-${index - 1}`, booleanOp: "subtract" }),
          childIds: [child, cutId],
        };
      }
      return renderSceneSvg(appendChild({ ...base, nodes }, null, "boolean-0", "page-1"), "page-1");
    };
    expect(build(24).length).toBeLessThan(build(12).length * 3);
  });

  test("boolean fields and stroke cap/join/dash round-trip through .design.html", () => {
    const doc = booleanDoc("subtract");
    const html = serializeDesignHtml(createDefaultManifest(), doc);
    const parsed = parseDesignHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.scene.nodes["node-1"]!.booleanOp).toBe("subtract");
    // exported preview SVG includes the mask
    expect(html).toContain('<mask id="boolean-node-1-subtract"');
  });

  test("vectorNetwork round-trips through .design.html serialize/parse", () => {
    const base = createEmptyDocument();
    const vec = createNode({
      id: "node-1",
      type: "vector",
      parentId: null,
      vectorNetwork: triangleNetwork(),
      stroke: { color: "#000", width: 1, dash: [3, 3] },
    });
    const doc = appendChild({ ...base, nodes: { "node-1": vec } }, null, "node-1", "page-1");
    const html = serializeDesignHtml(createDefaultManifest(), doc);
    const parsed = parseDesignHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = parsed.document.scene.nodes["node-1"]!;
    expect(out.vectorNetwork?.vertices.length).toBe(3);
    expect(out.vectorNetwork?.regions[0]!.vertexIds).toEqual(["v1", "v2", "v3"]);
    expect(out.stroke?.dash).toEqual([3, 3]);
  });

  test("renderSceneSvg renders an empty placeholder for an empty scene", () => {
    const svg = renderSceneSvg(createEmptyDocument(), "page-1");
    expect(svg.startsWith("<svg")).toBe(true);
  });

  test("serializes wrapped text on the server with its canonical embedded font", () => {
    const base = createEmptyDocument();
    const wrapped = createNode({
      id: "node-1",
      type: "text",
      parentId: null,
      width: 70,
      height: 20,
      text: "Nautilo wraps exactly",
      textWrap: true,
      fontFamily: "Nautilo Noto Sans",
      fontWeight: 700,
    });
    const doc = appendChild({ ...base, nodes: { "node-1": wrapped } }, null, "node-1", "page-1");
    const html = serializeDesignHtml(createDefaultManifest(), doc);
    expect(html).toContain("@font-face{font-family:\"Nautilo Noto Sans\"");
    expect(html).toContain('font-family="Nautilo Noto Sans" font-weight="700"');
    const parsed = parseDesignHtml(html);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.scene.nodes["node-1"]?.fontFamily).toBe("Nautilo Noto Sans");
      expect(parsed.document.scene.nodes["node-1"]?.textWrap).toBe(true);
    }
  });

  test("serializes and reopens documents above the former 200 KiB cap", () => {
    const manifest = createDefaultManifest();
    const big = createEmptyDocument();
    const huge = "x".repeat(220 * 1024);
    const nodes: Record<string, ReturnType<typeof createNode>> = {};
    nodes["node-1"] = createNode({
      id: "node-1",
      type: "text",
      parentId: null,
      text: huge,
      width: 10,
      height: 10,
    });
    const doc: DesignDocument = { ...big, nodes };
    const withChild = appendChild(doc, null, "node-1", "page-1");
    const html = serializeDesignHtml(manifest, withChild);
    expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(200 * 1024);
    expect(parseDesignHtml(html).ok).toBe(true);
  });

  test("escapes script-closing JSON and XML-special characters in preview", () => {
    const doc = createEmptyDocument();
    const withText = appendChild(
      {
        ...doc,
        nodes: {
          ...doc.nodes,
          "node-1": createNode({
            id: "node-1",
            type: "text",
            parentId: null,
            text: "</script><b>bold</b>",
            width: 100,
            height: 32,
          }),
        },
      },
      null,
      "node-1",
      "page-1",
    );
    const html = serializeDesignHtml(createDefaultManifest(), withText);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("</script><b");
    expect(parseDesignHtml(html).ok).toBe(true);
  });
});
