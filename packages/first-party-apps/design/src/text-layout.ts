import type { DesignNode } from "./scene-graph";
import {
  DESIGN_BUNDLED_FONT_FAMILIES,
  DESIGN_BUNDLED_FONT_FAMILY,
  designBundledFontFaceKey,
  designBundledFontForStyle,
  designBundledFontWeights,
  isDesignBundledFontFamily,
  type DesignBundledFontFaceKey,
  type DesignBundledFontFamily,
  type DesignBundledFontWeight,
} from "./bundled-fonts";

export type TextMeasureStyle = {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
};

export type TextMeasurer = (text: string, style: TextMeasureStyle) => number;

type TextMeasureContext = {
  font: string;
  measureText(text: string): { width: number };
};

export type TextMeasureDocument = {
  createElement(tagName: "canvas"): {
    getContext(contextId: "2d"): TextMeasureContext | null;
  };
};

export type TextLayout = {
  lines: string[];
  lineHeight: number;
  measuredWidth: number;
  measured: boolean;
};

export type TextRenderStyle = TextMeasureStyle & {
  bundled: boolean;
};

const LEGACY_BUNDLED_FAMILY_ALIASES = new Set([
  DESIGN_BUNDLED_FONT_FAMILY.toLowerCase(),
  "sans-serif",
  "system-ui",
  "system-ui, sans-serif",
]);

function bundledWeight(value: string | number): DesignBundledFontWeight | null {
  if (value === "normal" || value === 400 || value === "400") return 400;
  if (value === "bold" || value === 700 || value === "700") return 700;
  return null;
}

function bundledFamily(value: string, allowLegacyAliases: boolean): DesignBundledFontFamily | null {
  const normalized = value.trim().toLowerCase();
  const exact = DESIGN_BUNDLED_FONT_FAMILIES.find((family) => family.toLowerCase() === normalized);
  if (exact) return exact;
  return allowLegacyAliases && LEGACY_BUNDLED_FAMILY_ALIASES.has(normalized)
    ? DESIGN_BUNDLED_FONT_FAMILY
    : null;
}

function bundledStyle(style: TextMeasureStyle, allowLegacyAliases = true): TextRenderStyle {
  const family = bundledFamily(style.fontFamily, allowLegacyAliases);
  if (!family) {
    throw new Error(`Wrapped text supports ${DESIGN_BUNDLED_FONT_FAMILIES.join(", ")}; received ${style.fontFamily}.`);
  }
  const weight = bundledWeight(style.fontWeight);
  if (weight === null || !designBundledFontWeights(family).includes(weight)) {
    throw new Error(`${family} does not include an exact ${String(style.fontWeight)} font face.`);
  }
  return {
    fontFamily: family,
    fontSize: style.fontSize,
    fontWeight: weight,
    bundled: true,
  };
}

/** Resolve the actual family and weight emitted for a text node. */
export function textRenderStyle(node: DesignNode): TextRenderStyle {
  const style: TextMeasureStyle = {
    fontFamily: node.fontFamily ?? "system-ui, sans-serif",
    fontSize: node.fontSize ?? 14,
    fontWeight: node.fontWeight ?? "normal",
  };
  if (node.textWrap) return bundledStyle(style);
  const family = bundledFamily(style.fontFamily, false);
  if (family) {
    // CSS font matching chooses the regular face for 500 and the bold face
    // for 600 when only 400 and 700 are available. Keep legacy unwrapped
    // weights readable while using the same actual glyphs in both renderers.
    const weight = family === DESIGN_BUNDLED_FONT_FAMILY && (style.fontWeight === 500 || style.fontWeight === "500") ? 400
      : family === DESIGN_BUNDLED_FONT_FAMILY && (style.fontWeight === 600 || style.fontWeight === "600") ? 700
      : bundledWeight(style.fontWeight);
    if (weight !== null && designBundledFontWeights(family).includes(weight)) {
      return bundledStyle({ ...style, fontFamily: family, fontWeight: weight }, false);
    }
    throw new Error(`${family} does not include an exact ${String(style.fontWeight)} font face.`);
  }
  return { ...style, bundled: false };
}

export function bundledFontTextByWeight(nodes: Iterable<DesignNode>): Map<DesignBundledFontFaceKey, string> {
  const result = new Map<DesignBundledFontFaceKey, string>();
  for (const node of nodes) {
    if (node.type !== "text" || !(node.text ?? "").length) continue;
    const style = textRenderStyle(node);
    if (!style.bundled) continue;
    const family = style.fontFamily as DesignBundledFontFamily;
    const weight = style.fontWeight as DesignBundledFontWeight;
    // The complete standalone face is embedded once per used weight. Retain a
    // non-empty marker rather than duplicating every document string in memory.
    result.set(designBundledFontFaceKey(family, weight), " ");
  }
  return result;
}

/** Exact advances from the same embedded font bytes used by live and export SVG. */
export const measureBundledText: TextMeasurer = (text, style) => {
  const resolved = bundledStyle(style);
  const family = resolved.fontFamily as DesignBundledFontFamily;
  const font = designBundledFontForStyle(
    family,
    resolved.fontWeight as DesignBundledFontWeight,
  );
  if (!font) throw new Error(`${family} does not include an exact ${String(resolved.fontWeight)} font face.`);
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0x20 && !font.hasGlyphForCodePoint(codePoint)) {
      throw new Error(`Wrapped text contains a character unsupported by ${family}: U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}.`);
    }
  }
  const advance = font.layout(text).positions.reduce((total, position) => total + position.xAdvance, 0);
  return advance * resolved.fontSize / font.unitsPerEm;
};

function ambientTextMeasureDocument(): TextMeasureDocument | null {
  const candidate = (globalThis as { document?: unknown }).document;
  if (!candidate || typeof candidate !== "object" || !("createElement" in candidate)
    || typeof candidate.createElement !== "function") return null;
  return candidate as TextMeasureDocument;
}

/** Browser Canvas measurement without imposing DOM types on server consumers. */
export function createBrowserTextMeasurer(
  browserDocument: TextMeasureDocument | null = ambientTextMeasureDocument(),
): TextMeasurer | null {
  if (!browserDocument) return null;
  let context: TextMeasureContext | null = null;
  try {
    context = browserDocument.createElement("canvas").getContext("2d");
  } catch {
    return null;
  }
  if (!context) return null;
  return (text, style) => {
    context.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
    return context.measureText(text).width;
  };
}

function breakToken(token: string, width: number, measure: (text: string) => number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const character of Array.from(token)) {
    const candidate = current + character;
    if (current && measure(candidate) > width) {
      parts.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current || parts.length === 0) parts.push(current);
  return parts;
}

function wrapParagraph(paragraph: string, width: number, measure: (text: string) => number): string[] {
  if (paragraph.length === 0) return [""];
  const words = paragraph.match(/\S+\s*/gu) ?? [paragraph];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current + word;
    if (!current || measure(candidate) <= width) {
      if (measure(candidate) <= width) {
        current = candidate;
        continue;
      }
      const pieces = breakToken(word.trimEnd(), width, measure);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
      continue;
    }
    lines.push(current.trimEnd());
    if (measure(word) <= width) {
      current = word;
    } else {
      const pieces = breakToken(word.trimEnd(), width, measure);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
    }
  }
  lines.push(current.trimEnd());
  return lines;
}

/**
 * Lay out text with the same measured line decisions for live and export SVG.
 * Wrapped text fails explicitly when real font measurement is unavailable.
 */
export function layoutTextNode(node: DesignNode, measurer?: TextMeasurer | null): TextLayout {
  const fontSize = node.fontSize ?? 14;
  const fontStretch = node.fontStretch ?? 1;
  const lineHeight = fontSize * (node.lineHeight ?? 1.25);
  // Validate wrapped text independently of the measurement adapter. This keeps
  // a browser-only fallback font from creating a document the server cannot
  // later lay out exactly.
  const renderStyle = textRenderStyle(node);
  const style: TextMeasureStyle = renderStyle;
  const font = renderStyle.bundled && isDesignBundledFontFamily(renderStyle.fontFamily)
    ? designBundledFontForStyle(
        renderStyle.fontFamily,
        renderStyle.fontWeight as DesignBundledFontWeight,
      )
    : null;
  const bundledCoverage = font !== null && Array.from(node.text ?? "").every((character) =>
    character.codePointAt(0)! < 0x20 || font.hasGlyphForCodePoint(character.codePointAt(0)!));
  const resolvedMeasurer = measurer === undefined
    // Unwrapped text retains browser fallback glyphs; PNG separately requires
    // complete bundled-font coverage before artifact creation.
    ? renderStyle.bundled && (node.textWrap || bundledCoverage) ? measureBundledText : createBrowserTextMeasurer()
    : measurer;
  if (!node.textWrap) {
    const lines = (node.text ?? "").split("\n");
    return {
      lines,
      lineHeight,
      measuredWidth: resolvedMeasurer ? Math.max(0, ...lines.map((line) => resolvedMeasurer(line, style) * fontStretch)) : node.width,
      measured: resolvedMeasurer !== null,
    };
  }
  if (!resolvedMeasurer) {
    throw new Error(`Wrapped text "${node.name}" requires font measurement in this renderer.`);
  }
  const measure = (text: string): number => resolvedMeasurer(text, style) * fontStretch;
  const lines = (node.text ?? "").split("\n").flatMap((paragraph) => wrapParagraph(paragraph, node.width, measure));
  return {
    lines,
    lineHeight,
    measuredWidth: Math.max(0, ...lines.map(measure)),
    measured: true,
  };
}
