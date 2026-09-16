import { describe, expect, test } from "bun:test";
import { serializeCanonicalWriterHtml } from "@nautilo/writer-proposal-core";

import { prepareWriterPreview } from "./artifact-writer-preview-model";

const manifest = {
  documentType: "document" as const,
  editor: "wafflebase" as const,
  payloadId: "document-data",
  payloadFormat: "application/vnd.wafflebase.document+json" as const,
  version: "1.0" as const,
};

function writer(blocks: unknown[]) {
  return serializeCanonicalWriterHtml(manifest, { blocks });
}

function paragraph(id: string, text: string, style: Record<string, unknown> = {}) {
  return { id, type: "paragraph", inlines: [{ text, style }], style: {} };
}

describe("prepareWriterPreview", () => {
  test("prepares the supported Writer reading subset without flattening blocks or inline styles", () => {
    const prepared = prepareWriterPreview(writer([
      { id: "h", type: "heading", headingLevel: 2, inlines: [{ text: "Heading", style: { bold: true } }], style: {} },
      paragraph("p", "Body", { italic: true, underline: true, color: "#123456" }),
      { id: "u", type: "list-item", listKind: "unordered", listLevel: 0, inlines: [{ text: "First", style: {} }], style: {} },
      { id: "o", type: "list-item", listKind: "ordered", listLevel: 0, inlines: [{ text: "Link", style: { href: "https://nautilo.ai" } }], style: {} },
    ]));

    expect(prepared).toMatchObject({
      ok: true,
      document: {
        blocks: [
          { id: "h", type: "heading", headingLevel: 2, inlines: [{ text: "Heading", style: { bold: true } }] },
          { id: "p", type: "paragraph", inlines: [{ text: "Body", style: { italic: true, underline: true, color: "#123456" } }] },
          { id: "u", type: "list-item", listKind: "unordered" },
          { id: "o", type: "list-item", listKind: "ordered", inlines: [{ style: { href: "https://nautilo.ai" } }] },
        ],
      },
    });
  });

  test("fails closed for non-Writer HTML, unsupported structures, nested lists, and unsafe links", () => {
    expect(prepareWriterPreview("<html><body>Hello</body></html>")).toEqual({ ok: false, reason: "invalid_writer" });
    expect(prepareWriterPreview(writer([{ id: "t", type: "table", inlines: [], style: {} }]))).toEqual({ ok: false, reason: "unsupported_structure" });
    expect(prepareWriterPreview(writer([{ id: "l", type: "list-item", listKind: "ordered", listLevel: 1, inlines: [], style: {} }]))).toEqual({ ok: false, reason: "unsupported_structure" });
    expect(prepareWriterPreview(writer([paragraph("p", "bad", { href: "javascript:alert(1)" })]))).toEqual({ ok: false, reason: "unsupported_structure" });
  });

  test("handles a D372-sized supported block shape", () => {
    const blocks = Array.from({ length: 869 }, (_, index) => {
      if (index < 39) return { id: `h-${index}`, type: "heading", headingLevel: 2, inlines: [{ text: `Heading ${index}`, style: {} }], style: {} };
      if (index < 56) return { id: `l-${index}`, type: "list-item", listKind: index % 2 ? "ordered" : "unordered", listLevel: 0, inlines: [{ text: `Item ${index}`, style: {} }], style: {} };
      return paragraph(`p-${index}`, `Paragraph ${index} — Unicode ✓`);
    });
    const prepared = prepareWriterPreview(writer(blocks));
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.document.blocks).toHaveLength(869);
  });
});
