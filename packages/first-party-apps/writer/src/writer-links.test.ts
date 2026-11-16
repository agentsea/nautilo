import { describe, expect, test } from "bun:test";
import { installWriterTestDom } from "./test-dom";
import { buildDocumentPreviewHtml, createDefaultManifest, parseWriterHtml, serializeWriterHtml, type WafflebaseDocumentPayload } from "./office-document";
import { mapWriterDocumentToOfficeCliBatch } from "./docx-mapper";

installWriterTestDom();
const href = 'https://example.com/research?q=one&label="two"#section';
const paragraph = (id: string, url = href) => ({ id, type: "paragraph", style: {}, inlines: [{ text: "Read <the> research", style: { href: url } }] });
const doc: WafflebaseDocumentPayload = { blocks: [
  paragraph("p1"),
  { id: "list", type: "list-item", listKind: "unordered", style: {}, inlines: [{ text: "Contact", style: { href: "mailto:sample@example.com" } }] },
  { id: "table", type: "table", style: {}, inlines: [], tableData: { columnWidths: [120], rows: [{ cells: [{ blocks: [paragraph("cell")], style: {} }] }] } },
] };

function anchors(html: string): HTMLAnchorElement[] {
  const root = document.createElement("div"); root.innerHTML = html;
  return Array.from(root.querySelectorAll("a"));
}

describe("Writer link preservation", () => {
  test("renders real escaped links in paragraphs, lists and table cells and retains them on reopen", () => {
    const saved = serializeWriterHtml(createDefaultManifest(), doc);
    const parsed = parseWriterHtml(saved);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.document.document).toEqual(doc);
    const links = anchors(buildDocumentPreviewHtml(parsed.document.document));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([href, "mailto:sample@example.com", href]);
    expect(links[0]!.textContent).toBe("Read <the> research");
    expect(serializeWriterHtml(parsed.document.manifest, parsed.document.document)).toBe(saved);
    expect(anchors(saved)[0]!.getAttribute("onclick")).toBeNull();
  });

  test("unsafe URLs remain stored but are never emitted as executable anchors", () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'java\nscript:alert(1)', 'https://exam\nple.com', '//example.com']) {
      const value = { blocks: [paragraph("unsafe", url)] };
      const saved = serializeWriterHtml(createDefaultManifest(), value);
      expect(anchors(saved)).toHaveLength(0);
      const parsed = parseWriterHtml(saved);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.document.document).toEqual(value);
    }
    expect(anchors(buildDocumentPreviewHtml({ blocks: [paragraph("anchor", "#section")] }))[0]!.getAttribute("href")).toBe("#section");
  });

  test("DOCX mapping emits the same external destinations, including table links", () => {
    const mapped = mapWriterDocumentToOfficeCliBatch(doc);
    const links = mapped.commands.filter((op) => op.command === "add" && op.type === "hyperlink");
    expect(links.map((op) => "props" in op ? op.props.url : undefined)).toEqual([href, "mailto:sample@example.com", href]);
  });

});
