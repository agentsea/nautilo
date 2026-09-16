import { expect, test } from "bun:test";
import {
  DESIGN_BUNDLED_FONT_FAMILY,
  DESIGN_BUNDLED_MONO_FONT_FAMILY,
  DESIGN_BUNDLED_SERIF_FONT_FAMILY,
} from "./bundled-fonts";
import { renderSceneSvg } from "./design-document";
import { createEmptyDocument, createNode } from "./scene-graph";
import { textOutlineGeometry, textOutlinePath } from "./text-outlines";
import { layoutTextNode, measureBundledText, textRenderStyle } from "./text-layout";

function textNode() {
  return createNode({ id: "label", type: "text", parentId: null, x: 20, y: 30,
    width: 90, height: 60, text: "AV café\nBold", fontSize: 20,
    fontFamily: DESIGN_BUNDLED_FONT_FAMILY, fontWeight: "bold", textWrap: true });
}

test("raster SVG outlines text without changing its viewport, wrap, paint or transform", () => {
  const doc = createEmptyDocument();
  const node = { ...textNode(), rotation: 23, fontStretch: 1.4, color: "#bc1234", textAlign: "center" as const };
  doc.nodes[node.id] = node;
  doc.pages[0]!.children.push(node.id);
  const svg = renderSceneSvg(doc);
  const outlined = renderSceneSvg(doc, undefined, { outlineText: true });
  expect(outlined.match(/viewBox="([^"]+)"/)?.[1]).toBe(svg.match(/viewBox="([^"]+)"/)?.[1]);
  expect(outlined).not.toMatch(/<(?:text|tspan|style)\b/);
  expect(outlined).not.toContain("data:font");
  expect(outlined).toContain('fill="#bc1234"');
  expect(outlined).toContain('scale(1.4 1)');
  expect(outlined).toContain('transform="matrix(');
  expect(outlined).toMatch(/d="M[^"]+[LQC]/);
  expect(layoutTextNode(node, measureBundledText).lines.length).toBeGreaterThan(1);
});

test("unwrapped bundled text embeds and outlines the same deterministic font", () => {
  const doc = createEmptyDocument();
  const node = { ...textNode(), textWrap: false };
  doc.nodes[node.id] = node;
  doc.pages[0]!.children.push(node.id);
  expect(renderSceneSvg(doc)).toContain("@font-face");
  expect(textOutlinePath(node)).not.toBe("");
  expect(layoutTextNode(node).measured).toBe(true);
});

test("Serif and Mono use their exact embedded face for SVG and PNG outlines", () => {
  const outputs = [DESIGN_BUNDLED_SERIF_FONT_FAMILY, DESIGN_BUNDLED_MONO_FONT_FAMILY].map((fontFamily) => {
    const doc = createEmptyDocument();
    const node = { ...textNode(), textWrap: true, text: "Exact café", fontFamily, fontWeight: 400 };
    doc.nodes[node.id] = node;
    doc.pages[0]!.children.push(node.id);
    const svg = renderSceneSvg(doc);
    const outlined = renderSceneSvg(doc, undefined, { outlineText: true });
    expect(svg).toContain(`font-family:${JSON.stringify(fontFamily)}`);
    expect(svg.match(/@font-face/g)).toHaveLength(1);
    expect(outlined).not.toMatch(/<(?:text|tspan|style)\b/);
    expect(textOutlinePath(node)).not.toBe("");
    return textOutlinePath(node);
  });
  expect(outputs[0]).not.toBe(outputs[1]);
});

test("unwrapped default Noto intermediate weights resolve to the installed face in SVG and PNG outlines", () => {
  for (const [requested, resolved] of [[500, 400], [600, 700]] as const) {
    const node = { ...textNode(), textWrap: false, text: "Noto", fontWeight: requested };
    const doc = createEmptyDocument();
    doc.nodes[node.id] = node;
    doc.pages[0]!.children.push(node.id);

    expect(textRenderStyle(node)).toMatchObject({ bundled: true, fontWeight: resolved });
    expect(renderSceneSvg(doc)).toContain(`font-weight="${resolved}"`);
    expect(textOutlinePath(node)).toBe(textOutlinePath({ ...node, fontWeight: resolved }));
  }
});

test("legacy unwrapped unsupported text remains readable SVG while PNG outlines fail explicitly", () => {
  const node = { ...textNode(), textWrap: false, text: "Legacy \u{1F600}" };
  const doc = createEmptyDocument();
  doc.nodes[node.id] = node;
  doc.pages[0]!.children.push(node.id);

  const svg = renderSceneSvg(doc);
  expect(svg).toContain("<text");
  expect(svg).toContain("Legacy \u{1F600}");
  expect(() => textOutlinePath(node)).toThrow("unsupported");
});

test("wrapped overwide glyphs expand the export viewport to contain their ink", () => {
  const node = createNode({
    id: "wide-glyph",
    type: "text",
    parentId: null,
    x: 20,
    y: 30,
    width: 1,
    height: 1_200,
    text: "W",
    textWrap: true,
    fontFamily: DESIGN_BUNDLED_FONT_FAMILY,
    fontWeight: 400,
    fontSize: 1_000,
  });
  const doc = createEmptyDocument();
  doc.nodes[node.id] = node;
  doc.pages[0]!.children.push(node.id);
  const ink = textOutlineGeometry(node).bounds;
  const viewBox = renderSceneSvg(doc, undefined, { outlineText: true })
    .match(/viewBox="([^"]+)"/)?.[1]
    ?.split(" ")
    .map(Number);

  expect(ink).not.toBeNull();
  expect(viewBox).toHaveLength(4);
  if (!ink || !viewBox) return;
  const [minX, minY, width, height] = viewBox as [number, number, number, number];
  expect(ink.maxX - ink.minX).toBeGreaterThan(node.width);
  expect(minX).toBeLessThanOrEqual(ink.minX);
  expect(minY).toBeLessThanOrEqual(ink.minY);
  expect(minX + width).toBeGreaterThanOrEqual(ink.maxX);
  expect(minY + height).toBeGreaterThanOrEqual(ink.maxY);
});

test("PNG text fails explicitly for an ambient font or unavailable glyph", () => {
  expect(() => textOutlinePath({ ...textNode(), textWrap: false, fontFamily: "Helvetica" })).toThrow("Set its font family");
  expect(() => textOutlinePath({ ...textNode(), text: "\u{1F600}" })).toThrow("unsupported");
});

test("outlining one label does not mutate shared glyph paths", () => {
  const node = textNode();
  const original = textOutlinePath(node);
  textOutlinePath({ ...node, x: 700, y: -200, fontSize: 50, textAlign: "right" });
  expect(textOutlinePath(node)).toBe(original);
});

test("outlining rejects only unsupported text in the requested visible scope", () => {
  const doc = createEmptyDocument();
  const label = textNode();
  const other = { ...textNode(), id: "other", textWrap: false, fontFamily: "Ambient" };
  doc.nodes[label.id] = label;
  doc.nodes[other.id] = other;
  doc.pages[0]!.children.push(label.id, other.id);
  expect(() => renderSceneSvg(doc, undefined, { outlineText: true })).toThrow("Set its font family");
  expect(() => renderSceneSvg(doc, undefined, { outlineText: true, nodeIds: [label.id] })).not.toThrow();
});
