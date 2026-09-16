import {
  DESIGN_BUNDLED_FONT_FAMILIES,
  designBundledFontForStyle,
  isDesignBundledFontFamily,
  type DesignBundledFontWeight,
} from "./bundled-fonts";
import type { DesignNode } from "./scene-graph";
import { layoutTextNode, measureBundledText, textRenderStyle } from "./text-layout";

/**
 * Glyph outlines from the exact font used by the editor. Rasterizers need no
 * system font installation and cannot silently replace an embedded SVG font.
 * Coordinates are transformed into document units, preserving stroke width.
 */
export type TextOutlineGeometry = {
  path: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
};

export function textOutlineGeometry(node: DesignNode): TextOutlineGeometry {
  if (!(node.text ?? "").length) return { path: "", bounds: null };
  const style = textRenderStyle(node);
  if (!style.bundled) {
    throw new Error(`PNG export cannot reproduce the font in "${node.name}". Set its font family to ${DESIGN_BUNDLED_FONT_FAMILIES.join(", ")}, or export SVG.`);
  }
  if (!isDesignBundledFontFamily(style.fontFamily)) {
    throw new Error(`PNG export cannot resolve the bundled font in "${node.name}".`);
  }
  const font = designBundledFontForStyle(
    style.fontFamily,
    style.fontWeight as DesignBundledFontWeight,
  );
  if (!font) {
    throw new Error(`${style.fontFamily} does not include an exact ${String(style.fontWeight)} font face.`);
  }
  const scale = style.fontSize / font.unitsPerEm;
  const layout = layoutTextNode(node, measureBundledText);
  const anchor = node.textAlign === "center" ? 0.5 : node.textAlign === "right" ? 1 : 0;
  const paths: string[] = [];
  let bounds: TextOutlineGeometry["bounds"] = null;
  for (const [index, line] of layout.lines.entries()) {
    // Validate coverage before shaping; a missing-glyph box is not the artwork.
    const width = measureBundledText(line, style);
    const run = font.layout(line);
    let x = node.x + anchor * (node.width - width);
    let y = node.y + style.fontSize + index * layout.lineHeight;
    for (const [glyphIndex, glyph] of run.glyphs.entries()) {
      const position = run.positions[glyphIndex]!;
      const path = glyph.path.transform(
        scale, 0, 0, -scale,
        x + position.xOffset * scale,
        y - position.yOffset * scale,
      );
      const data = path.toSVG();
      paths.push(data);
      if (data) {
        const ink = path.bbox;
        bounds = bounds ? {
          minX: Math.min(bounds.minX, ink.minX), minY: Math.min(bounds.minY, ink.minY),
          maxX: Math.max(bounds.maxX, ink.maxX), maxY: Math.max(bounds.maxY, ink.maxY),
        } : { ...ink };
      }
      x += position.xAdvance * scale;
      y -= position.yAdvance * scale;
    }
  }
  return { path: paths.join(""), bounds };
}

export function textOutlinePath(node: DesignNode): string {
  return textOutlineGeometry(node).path;
}
