import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  rasterizeResourceFreeSvg,
  validateResourceFreeSvg,
} from "../../src/apps/svg-raster";
import { renderSceneSvg } from "../../../first-party-apps/design/src/design-document";
import {
  appendChild,
  createEmptyDocument,
  createNode,
  type DesignDocument,
} from "../../../first-party-apps/design/src/scene-graph";

const svg = (body: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="17" height="9" viewBox="0 0 17 9"${attrs}>${body}</svg>`;

async function alphaBounds(bytes: Uint8Array): Promise<{ minX: number; minY: number; maxX: number; maxY: number }> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    if (data[(y * info.width + x) * info.channels + info.channels - 1]! === 0) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < 0 || maxY < 0) throw new Error("Expected visible raster ink.");
  return { minX, minY, maxX, maxY };
}

describe("resource-free SVG rasterization", () => {
  test("accepts canonical paths, glyph transforms, rectangles, and exact Boolean references", () => {
    const source = svg(
      '<defs>' +
        '<g id="shape_a"><path d="M0 0L17 0L17 9L0 9Z"/></g>' +
        '<g id="shape_b"><path d="M2 2Q4 0 6 2C8 4 10 4 12 2Z"/></g>' +
        '<mask id="mask_a" maskUnits="userSpaceOnUse" x="0" y="0" width="17" height="9">' +
          '<use href="#shape_a"/><g fill="black"><use href="#shape_b"/></g>' +
        '</mask>' +
      '</defs>' +
      '<g opacity="0.75" fill="rgba(12, 34, 56, 0.5)" mask="url(#mask_a)">' +
        '<use href="#shape_a"/>' +
      '</g>' +
      '<g fill="#abcdef" transform="translate(1 2) scale(0.02 -0.02)">' +
        '<path d="M0 0L100 0Q120 20 100 40Z"/>' +
      '</g>' +
      '<rect x="1" y="1" width="4" height="3" rx="1" ry="1" stroke="red" stroke-width="1" fill="none"/>',
    );
    expect(() => validateResourceFreeSvg(source)).not.toThrow();
  });

  test("accepts only real CSS named colors", () => {
    expect(() => validateResourceFreeSvg(svg('<rect x="0" y="0" width="1" height="1" fill="RebeccaPurple"/>'))).not.toThrow();
    expect(() => validateResourceFreeSvg(svg('<rect x="0" y="0" width="1" height="1" fill="transparent"/>'))).not.toThrow();
    expect(() => validateResourceFreeSvg(svg('<rect x="0" y="0" width="1" height="1" fill="definitelynotacolor"/>'))).toThrow(
      "unsupported paint value",
    );
  });

  test("rasterizes canonical Design output with outlined bundled text, transforms, strokes, and a Boolean", async () => {
    const base = createEmptyDocument();
    const label = createNode({
      id: "label",
      type: "text",
      parentId: null,
      x: 10,
      y: 8,
      width: 75,
      height: 50,
      text: "AV café wraps exactly",
      textWrap: true,
      fontFamily: "Nautilo Noto Sans",
      fontWeight: 700,
      fontSize: 14,
      color: "#1f2937",
    });
    const blank = createNode({
      id: "blank",
      type: "text",
      parentId: null,
      x: 10,
      y: 65,
      width: 30,
      height: 20,
      text: "  \n ",
      fontFamily: "Nautilo Noto Sans",
    });
    const transformed = createNode({
      id: "transformed",
      type: "rectangle",
      parentId: null,
      x: 105,
      y: 12,
      width: 35,
      height: 24,
      rotation: 18,
      skewX: 7,
      fills: [{ kind: "solid", color: "rebeccapurple" }],
      stroke: { color: "#0f172a", width: 2, cap: "round", join: "bevel" },
    });
    const boolean = createNode({
      id: "boolean",
      type: "group",
      parentId: null,
      x: 95,
      y: 50,
      width: 55,
      height: 35,
      booleanOp: "subtract",
      fills: [{ kind: "solid", color: "#22c55e" }],
    });
    const outer = createNode({
      id: "outer",
      type: "rectangle",
      parentId: boolean.id,
      x: 95,
      y: 50,
      width: 55,
      height: 35,
    });
    const cutout = createNode({
      id: "cutout",
      type: "rectangle",
      parentId: boolean.id,
      x: 110,
      y: 58,
      width: 22,
      height: 18,
      rotation: 12,
    });
    const nodes = { label, blank, transformed, boolean, outer, cutout };
    let document: DesignDocument = { ...base, nodes };
    document = appendChild(document, null, label.id, "page-1");
    document = appendChild(document, null, blank.id, "page-1");
    document = appendChild(document, null, transformed.id, "page-1");
    document = appendChild(document, null, boolean.id, "page-1");
    document = appendChild(document, boolean.id, outer.id);
    document = appendChild(document, boolean.id, cutout.id);

    const canonical = renderSceneSvg(document, "page-1", { outlineText: true });
    expect(canonical).not.toMatch(/<(?:text|tspan|style)\b/);
    expect(canonical).not.toContain('d=""');
    const result = await rasterizeResourceFreeSvg(canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect([...result.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test("rasterizes unwrapped default Noto intermediate weights through their installed faces", async () => {
    for (const [weight, resolved] of [[500, 400], [600, 700]] as const) {
      const document = createEmptyDocument();
      const label = createNode({
        id: `noto-${weight}`,
        type: "text",
        parentId: null,
        x: 20,
        y: 30,
        width: 140,
        height: 50,
        text: "Noto export",
        textWrap: false,
        fontFamily: "Nautilo Noto Sans",
        fontWeight: weight,
        fontSize: 28,
      });
      document.nodes[label.id] = label;
      document.pages[0]!.children.push(label.id);
      const canonical = renderSceneSvg(document, "page-1", { outlineText: true });

      expect(canonical).not.toContain("<text");
      expect(renderSceneSvg(document)).toContain(`font-weight="${resolved}"`);
      const result = await rasterizeResourceFreeSvg(canonical);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const ink = await alphaBounds(result.bytes);
      expect(ink.maxX).toBeGreaterThanOrEqual(ink.minX);
      expect(ink.maxY).toBeGreaterThanOrEqual(ink.minY);
    }
  });

  test("keeps thick transformed shape and text ink comfortably inside raster output", async () => {
    const document = createEmptyDocument();
    const shape = createNode({
      id: "thick-shape",
      type: "rectangle",
      parentId: null,
      x: 45,
      y: 80,
      width: 100,
      height: 70,
      rotation: 21,
      skewX: 12,
      fills: [{ kind: "solid", color: "#2563eb" }],
      stroke: { color: "#111827", width: 20, cap: "round", join: "miter" },
    });
    const label = createNode({
      id: "transformed-label",
      type: "text",
      parentId: null,
      x: 190,
      y: 80,
      width: 100,
      height: 70,
      text: "Ink",
      textWrap: true,
      fontFamily: "Nautilo Noto Sans",
      fontWeight: 700,
      fontSize: 50,
      fontStretch: 1.35,
      rotation: -27,
      skewX: -9,
      color: "#9f1239",
      stroke: { color: "#111827", width: 12, cap: "round", join: "miter" },
    });
    document.nodes[shape.id] = shape;
    document.nodes[label.id] = label;
    document.pages[0]!.children.push(shape.id, label.id);

    const result = await rasterizeResourceFreeSvg(
      renderSceneSvg(document, "page-1", { outlineText: true }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ink = await alphaBounds(result.bytes);
    expect(ink.minX).toBeGreaterThanOrEqual(16);
    expect(ink.minY).toBeGreaterThanOrEqual(16);
    expect(ink.maxX).toBeLessThanOrEqual(result.width - 17);
    expect(ink.maxY).toBeLessThanOrEqual(result.height - 17);
  });

  test("produces a real PNG at the canonical SVG dimensions", async () => {
    const result = await rasterizeResourceFreeSvg(
      svg('<rect x="0" y="0" width="17" height="9" fill="#2563eb"/>'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(17);
    expect(result.height).toBe(9);
    expect([...result.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test.each([
    ["doctype", '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
    ["entity", '<!DOCTYPE svg [<!ENTITY x "x">]><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
    ["processing instruction", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
    ["style", svg("<style>path{fill:red}</style>")],
    ["text", svg("<text>ambient font</text>")],
    ["image", svg('<image href="file:///etc/passwd"/>')],
    ["foreign object", svg("<foreignObject/>")],
    ["external use", svg('<use href="https://example.com/a.svg#shape"/>')],
    ["external mask", svg('<g mask="url(https://example.com/mask.svg#m)"/>')],
    ["external paint", svg('<rect x="0" y="0" width="1" height="1" fill="url(https://example.com/a.svg#paint)"/>')],
    ["missing reference", svg('<use href="#missing"/>')],
    ["non-group use target", svg('<defs><path id="shape" d="M0 0Z"/></defs><use href="#shape"/>')],
    ["duplicate id", svg('<g id="same"/><path id="same" d="M0 0Z"/>')],
    ["reference cycle", svg('<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>')],
    ["nested reference cycle", svg('<defs><g id="a"><g id="b"><use href="#a"/></g></g></defs><use href="#a"/>')],
    ["namespace escape", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="urn:x" width="1" height="1"><path x:href="file:///etc/passwd" d="M0 0Z"/></svg>'],
    ["unsupported path command", svg('<path d="M0 0A1 1 0 0 0 1 1Z"/>')],
    ["malformed XML", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><g></svg>'],
  ])("rejects %s before Sharp", async (_name, source) => {
    const result = await rasterizeResourceFreeSvg(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_SVG");
    expect(result.message.length).toBeGreaterThan(0);
  });
});
