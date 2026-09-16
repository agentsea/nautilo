/**
 * Writer office-document container — the TEXT artifact format for the Writer
 * mini-app (D372 / Nautilo Office). Mirrors the Spreadsheet container
 * (`../../excel/src/spreadsheet-html-document.ts`) but wraps a Wafflebase
 * `Document` (block model) instead of a Fortune workbook.
 *
 * WHY a text container: M193 `AnchoredTextPatch` is text-only, so office
 * artifacts must serialize to deterministic text — never binary OOXML. The
 * `.docx` boundary lives in the import/export pipeline (P4), not here.
 *
 * The container is an HTML document with two non-executable `<script>` blocks:
 *   - `script#manifest`  (application/vnd.nautilo.document+json)
 *   - `script#<payloadId>` (application/vnd.wafflebase.document+json) — the
 *     JSON of the Wafflebase `Document`.
 * Executable scripts and prototype-pollution keys are rejected on parse.
 */

import { parseWriterHtml as parseSharedWriterHtml, validateWafflebaseDocument as validateSharedWafflebaseDocument } from "@nautilo/writer-proposal-core";
import { isWriterImageInline, readImageInlineStyle } from "./docx-image";

export const NAUTILO_DOCUMENT_MANIFEST_TYPE = "application/vnd.nautilo.document+json";
export const NAUTILO_DOCUMENT_MANIFEST_ID = "manifest";
export const WAFFLEBASE_DOCUMENT_TYPE = "application/vnd.wafflebase.document+json";
export const DEFAULT_DOCUMENT_PAYLOAD_ID = "wafflebase-document";
export const WRITER_DOCUMENT_TYPE = "document";
export const WRITER_EDITOR = "wafflebase";
export const WRITER_HTML_VERSION = "1.0";
/** Indexed image slot attribute for static Writer previews (hydrated by trusted host). */
export const WRITER_PREVIEW_IMAGE_INDEX_ATTR = "data-writer-image-index";
export const WRITER_PREVIEW_ROOT_CLASS = "nautilo-writer-preview";

/**
 * App-bridge write cap — keep in sync with the mini-app bridge text limit
 * (`MAX_APP_DOCUMENT_BYTES`) and the server artifact save/patch cap
 * (`USER_SAVE_TEXT_LIMIT_BYTES`). Sized to the officecli `.docx` generated
 * ceiling (`DELIVERED_FORMAT_LIMITS.generatedBytesDocx`) so a Writer document
 * that round-trips to `.docx` is never larger than officecli itself allows.
 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export type WriterHtmlManifest = {
  documentType: typeof WRITER_DOCUMENT_TYPE;
  editor: typeof WRITER_EDITOR;
  payloadId: string;
  payloadFormat: typeof WAFFLEBASE_DOCUMENT_TYPE;
  version: typeof WRITER_HTML_VERSION;
  metadata?: { createdBy?: string; updatedAt?: string };
};

/** Minimal shape we enforce; the engine validates the full block schema on load. */
export type WafflebaseDocumentPayload = {
  blocks: unknown[];
  [key: string]: unknown;
};

/** Bridge typed mapper output into the serializer's payload shape. */
export function wafflebaseDocumentToPayload(
  document: { readonly blocks: readonly unknown[] },
): WafflebaseDocumentPayload {
  return { blocks: [...document.blocks] };
}

export type WriterHtmlDocument = {
  manifest: WriterHtmlManifest;
  document: WafflebaseDocumentPayload;
};

export type WriterHtmlParseResult =
  | { ok: true; document: WriterHtmlDocument }
  | { ok: false; error: string };

export function validateWafflebaseDocument(value: unknown): WafflebaseDocumentPayload {
  return validateSharedWafflebaseDocument(value) as WafflebaseDocumentPayload;
}

export function createDefaultManifest(): WriterHtmlManifest {
  return {
    documentType: WRITER_DOCUMENT_TYPE,
    editor: WRITER_EDITOR,
    payloadId: DEFAULT_DOCUMENT_PAYLOAD_ID,
    payloadFormat: WAFFLEBASE_DOCUMENT_TYPE,
    version: WRITER_HTML_VERSION,
    metadata: { createdBy: "nautilo", updatedAt: new Date().toISOString() },
  };
}

export function createEmptyDocumentPayload(): WafflebaseDocumentPayload {
  return { blocks: [] };
}

type PreviewImageIndex = { next: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScriptJson(json: string): string {
  return json.replace(/<\/script/gi, "<\\/script");
}

function collectImageSourcesFromInlines(inlines: unknown, sources: string[]): void {
  if (!Array.isArray(inlines)) return;
  for (const inline of inlines) {
    if (!isRecord(inline)) continue;
    const style = inline["style"];
    if (!isRecord(style)) continue;
    if (!isWriterImageInline({ text: String(inline["text"] ?? ""), style })) continue;
    const imageStyle = readImageInlineStyle(style);
    if (imageStyle !== null) sources.push(imageStyle.src);
  }
}

function walkBlocksForImageSources(blocks: unknown, sources: string[]): void {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    collectImageSourcesFromInlines(block["inlines"], sources);
    if (block["type"] === "table") {
      const tableData = block["tableData"];
      if (!isRecord(tableData)) continue;
      const rows = tableData["rows"];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const cells = row["cells"];
        if (!Array.isArray(cells)) continue;
        for (const cell of cells) {
          if (!isRecord(cell)) continue;
          if (cell["colSpan"] === 0) continue;
          walkBlocksForImageSources(cell["blocks"], sources);
        }
      }
    }
  }
}

/** Collect embedded image data URLs in preview index order (payload only). */
export function collectWriterPreviewImageSources(doc: WafflebaseDocumentPayload): string[] {
  const sources: string[] = [];
  walkBlocksForImageSources(doc.blocks, sources);
  return sources;
}

function renderPreviewInlines(inlines: unknown, imageIndex: PreviewImageIndex): string {
  if (!Array.isArray(inlines)) return "";
  let html = "";
  for (const inline of inlines) {
    if (!isRecord(inline)) continue;
    const text = String(inline["text"] ?? "");
    const style = inline["style"];
    if (isRecord(style) && isWriterImageInline({ text, style })) {
      const imageStyle = readImageInlineStyle(style);
      if (imageStyle !== null) {
        const index = imageIndex.next++;
        const alt = escapeHtml(imageStyle.alt ?? "Embedded image");
        const dimAttrs: string[] = [];
        if (imageStyle.width !== undefined) {
          dimAttrs.push(` width="${escapeHtml(imageStyle.width)}"`);
        }
        if (imageStyle.height !== undefined) {
          dimAttrs.push(` height="${escapeHtml(imageStyle.height)}"`);
        }
        html +=
          `<figure class="nautilo-writer-preview-image" ${WRITER_PREVIEW_IMAGE_INDEX_ATTR}="${index}">` +
          `<img ${WRITER_PREVIEW_IMAGE_INDEX_ATTR}="${index}" alt="${alt}"` +
          `${dimAttrs.join("")} class="nautilo-writer-preview-image-slot" aria-hidden="true" />` +
          `<figcaption class="nautilo-writer-preview-image-fallback">Image preview unavailable</figcaption>` +
          `</figure>`;
        continue;
      }
    }
    if (text.length > 0) html += escapeHtml(text);
  }
  return html;
}

function renderPreviewBlock(block: Record<string, unknown>, imageIndex: PreviewImageIndex): string {
  const type = block["type"];
  const inlines = block["inlines"];
  const inlineHtml = renderPreviewInlines(inlines, imageIndex);

  if (type === "heading") {
    const level = Math.min(6, Math.max(1, Number(block["headingLevel"]) || 1));
    return inlineHtml.length > 0 ? `<h${level}>${inlineHtml}</h${level}>` : "";
  }
  if (type === "paragraph") {
    return inlineHtml.length > 0 ? `<p>${inlineHtml}</p>` : "";
  }
  if (type === "list-item") {
    return inlineHtml;
  }
  if (type === "horizontal-rule") {
    return "<hr />";
  }
  if (type === "page-break") {
    return `<div class="nautilo-writer-preview-page-break" aria-hidden="true"></div>`;
  }
  if (type === "table") {
    const tableData = block["tableData"];
    if (!isRecord(tableData)) return "";
    const rows = tableData["rows"];
    if (!Array.isArray(rows) || rows.length === 0) return "";
    let tableHtml = "<table><tbody>";
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const cells = row["cells"];
      if (!Array.isArray(cells)) continue;
      tableHtml += "<tr>";
      for (const cell of cells) {
        if (!isRecord(cell)) continue;
        if (cell["colSpan"] === 0) continue;
        const attrs: string[] = [];
        const colSpan = cell["colSpan"];
        const rowSpan = cell["rowSpan"];
        if (typeof colSpan === "number" && colSpan > 1) {
          attrs.push(` colspan="${colSpan}"`);
        }
        if (typeof rowSpan === "number" && rowSpan > 1) {
          attrs.push(` rowspan="${rowSpan}"`);
        }
        const cellBlocks = cell["blocks"];
        const cellHtml = Array.isArray(cellBlocks)
          ? cellBlocks
              .map((nested) => (isRecord(nested) ? renderPreviewBlock(nested, imageIndex) : ""))
              .filter((part) => part.length > 0)
              .join("")
          : "";
        tableHtml += `<td${attrs.join("")}>${cellHtml}</td>`;
      }
      tableHtml += "</tr>";
    }
    tableHtml += "</tbody></table>";
    return tableHtml;
  }

  return inlineHtml.length > 0 ? `<p>${inlineHtml}</p>` : "";
}

function renderPreviewBlocks(blocks: unknown[]): string {
  const imageIndex: PreviewImageIndex = { next: 0 };
  const parts: string[] = [];
  let listBuffer: { kind: "ordered" | "unordered"; items: string[] } | null = null;

  const flushList = (): void => {
    if (listBuffer === null) return;
    const tag = listBuffer.kind === "ordered" ? "ol" : "ul";
    parts.push(
      `<${tag}>${listBuffer.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`,
    );
    listBuffer = null;
  };

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block["type"] === "list-item") {
      const kind = block["listKind"] === "ordered" ? "ordered" : "unordered";
      const itemHtml = renderPreviewInlines(block["inlines"], imageIndex);
      if (listBuffer === null || listBuffer.kind !== kind) {
        flushList();
        listBuffer = { kind, items: [] };
      }
      listBuffer.items.push(itemHtml.length > 0 ? itemHtml : "&nbsp;");
      continue;
    }
    flushList();
    const rendered = renderPreviewBlock(block, imageIndex);
    if (rendered.length > 0) parts.push(rendered);
  }
  flushList();
  return parts.join("\n");
}

/** Semantic static preview for Reader/open-with (no engine, no canvas). */
export function buildDocumentPreviewHtml(doc: WafflebaseDocumentPayload): string {
  const body =
    doc.blocks.length > 0
      ? renderPreviewBlocks(doc.blocks)
      : "<p>Empty document. Open with Writer to edit.</p>";
  return `<main class="${WRITER_PREVIEW_ROOT_CLASS}">${body}</main>`;
}

export function parseWriterHtml(raw: string): WriterHtmlParseResult {
  return parseSharedWriterHtml(raw) as WriterHtmlParseResult;
}

export type SerializeWriterHtmlOptions = { touchMetadata?: boolean; updatedAt?: string };

export function serializeWriterHtml(
  manifest: WriterHtmlManifest,
  document: WafflebaseDocumentPayload,
  opts: SerializeWriterHtmlOptions = {},
): string {
  const normalized = validateWafflebaseDocument(document);
  const metadata =
    opts.touchMetadata === true
      ? { ...manifest.metadata, updatedAt: opts.updatedAt ?? new Date().toISOString() }
      : manifest.metadata;
  const nextManifest: WriterHtmlManifest = { ...manifest, ...(metadata ? { metadata } : {}) };
  const manifestJson = escapeScriptJson(JSON.stringify(nextManifest, null, 2));
  const documentJson = escapeScriptJson(JSON.stringify(normalized, null, 2));
  const preview = buildDocumentPreviewHtml(normalized);
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Document</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; color: #0f172a; background: #fff; }
      p, h1, h2, h3, h4, h5, h6 { margin: 0 0 0.6rem; }
      table { border-collapse: collapse; margin: 0 0 0.8rem; width: 100%; }
      td, th { border: 1px solid #cbd5e1; padding: 0.35rem 0.5rem; vertical-align: top; }
      .nautilo-writer-preview-image { margin: 0 0 0.8rem; max-width: 100%; }
      .nautilo-writer-preview-image-slot { display: block; max-width: 100%; height: auto; }
      .nautilo-writer-preview-image-fallback { margin: 0.25rem 0 0; font-size: 0.85rem; color: #64748b; }
    </style>
    <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="${NAUTILO_DOCUMENT_MANIFEST_ID}">
${manifestJson}
    </script>
    <script type="${manifest.payloadFormat}" id="${manifest.payloadId}">
${documentJson}
    </script>
  </head>
  <body>
    ${preview}
  </body>
</html>
`;
  if (new TextEncoder().encode(html).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES} bytes (app bridge limit).`);
  }
  return html;
}

export function createEmptyWriterHtml(): string {
  return serializeWriterHtml(createDefaultManifest(), createEmptyDocumentPayload());
}
