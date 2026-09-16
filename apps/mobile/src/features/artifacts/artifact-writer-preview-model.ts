import { parseWriterHtml } from "@nautilo/writer-proposal-core";

export type PreviewInlineStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  backgroundColor?: string;
  href?: string;
};

export type PreviewInline = { text: string; style: PreviewInlineStyle };
export type PreviewBlock = {
  id: string;
  type: "paragraph" | "heading" | "list-item";
  inlines: PreviewInline[];
  headingLevel?: number;
  listKind?: "ordered" | "unordered";
  listLevel?: number;
};

export type WriterPreviewDocument = { blocks: PreviewBlock[] };
export type WriterPreviewPreparation =
  | { ok: true; document: WriterPreviewDocument }
  | { ok: false; reason: "invalid_writer" | "unsupported_structure" };

const INLINE_STYLE_KEYS = new Set([
  "bold", "italic", "underline", "strikethrough", "fontSize", "fontFamily",
  "color", "backgroundColor", "href", "superscript", "subscript", "clear",
]);
const HEX_COLOR = /^#?(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SAFE_LINK = /^(?:https?:|mailto:)/i;

/** Parse canonical Writer data into a bounded, native read-only view model. */
export function prepareWriterPreview(sourceHtml: string): WriterPreviewPreparation {
  const parsed = parseWriterHtml(sourceHtml);
  if (!parsed.ok) return { ok: false, reason: "invalid_writer" };
  const blocks: PreviewBlock[] = [];
  for (const sourceBlock of parsed.document.document.blocks) {
    if (!isRecord(sourceBlock)) return { ok: false, reason: "unsupported_structure" };
    const { id, type, inlines } = sourceBlock;
    if (typeof id !== "string" || id.length === 0 || !Array.isArray(inlines)) return { ok: false, reason: "unsupported_structure" };
    if (type !== "paragraph" && type !== "heading" && type !== "list-item") return { ok: false, reason: "unsupported_structure" };
    const previewInlines: PreviewInline[] = [];
    for (const sourceInline of inlines) {
      if (!isRecord(sourceInline) || typeof sourceInline.text !== "string" || !isRecord(sourceInline.style)) return { ok: false, reason: "unsupported_structure" };
      const style = parseInlineStyle(sourceInline.style);
      if (!style) return { ok: false, reason: "unsupported_structure" };
      previewInlines.push({ text: sourceInline.text, style });
    }
    if (type === "heading") {
      if (!Number.isInteger(sourceBlock.headingLevel) || Number(sourceBlock.headingLevel) < 1 || Number(sourceBlock.headingLevel) > 6) return { ok: false, reason: "unsupported_structure" };
      blocks.push({ id, type, inlines: previewInlines, headingLevel: Number(sourceBlock.headingLevel) });
    } else if (type === "list-item") {
      if ((sourceBlock.listKind !== "ordered" && sourceBlock.listKind !== "unordered") || (sourceBlock.listLevel !== undefined && sourceBlock.listLevel !== 0)) return { ok: false, reason: "unsupported_structure" };
      blocks.push({ id, type, inlines: previewInlines, listKind: sourceBlock.listKind, listLevel: 0 });
    } else {
      blocks.push({ id, type, inlines: previewInlines });
    }
  }
  return { ok: true, document: { blocks } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseInlineStyle(source: Record<string, unknown>): PreviewInlineStyle | null {
  for (const key of Object.keys(source)) if (!INLINE_STYLE_KEYS.has(key)) return null;
  for (const key of ["bold", "italic", "underline", "strikethrough", "superscript", "subscript", "clear"] as const) {
    if (source[key] !== undefined && typeof source[key] !== "boolean") return null;
  }
  for (const key of ["color", "backgroundColor"] as const) {
    if (source[key] !== undefined && (typeof source[key] !== "string" || !HEX_COLOR.test(source[key]))) return null;
  }
  if (source.href !== undefined && (typeof source.href !== "string" || source.href.length > 2000 || !SAFE_LINK.test(source.href))) return null;
  return {
    ...(source.bold === true ? { bold: true } : {}),
    ...(source.italic === true ? { italic: true } : {}),
    ...(source.underline === true ? { underline: true } : {}),
    ...(source.strikethrough === true ? { strikethrough: true } : {}),
    ...(typeof source.color === "string" ? { color: normalizeColor(source.color) } : {}),
    ...(typeof source.backgroundColor === "string" ? { backgroundColor: normalizeColor(source.backgroundColor) } : {}),
    ...(typeof source.href === "string" ? { href: source.href } : {}),
  };
}

function normalizeColor(color: string): string {
  return color.startsWith("#") ? color : `#${color}`;
}
