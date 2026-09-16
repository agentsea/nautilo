import { describe, expect, test } from "bun:test";
import { serializeCanonicalWriterHtml } from "./writer-html";
import { buildStaticWriterDocument } from "./static-document";

const manifest = {
  documentType: "document" as const,
  editor: "wafflebase" as const,
  payloadId: "document-data",
  payloadFormat: "application/vnd.wafflebase.document+json" as const,
  version: "1.0" as const,
};
const source = (blocks: unknown[]) => serializeCanonicalWriterHtml(manifest, { blocks });
const paragraph = (id: string, text: string, style: Record<string, unknown> = {}) =>
  ({ id, type: "paragraph", inlines: [{ text, style }], style: {} });
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("buildStaticWriterDocument", () => {
  test("renders a body-empty canonical envelope from its payload with safe inline semantics", () => {
    const result = buildStaticWriterDocument(source([
      { id: "h", type: "heading", headingLevel: 2, inlines: [{ text: "Heading", style: { bold: true } }], style: {} },
      { id: "p", type: "paragraph", inlines: [
        { text: "em", style: { italic: true, underline: true, strikethrough: true } },
        { text: " code", style: { fontFamily: "monospace" } },
        { text: " link", style: { href: "https://example.test/read?q=1&x=2" } },
      ], style: {} },
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain("<h2><strong>Heading</strong></h2>");
    expect(result.html).toContain("<s><u><em>em</em></u></s>");
    expect(result.html).toContain('<code><span style="font-family:&quot;monospace&quot;"> code</span></code>');
    expect(result.html).toContain('href="https://example.test/read?q=1&amp;x=2"');
    expect(result.html).not.toContain("application/vnd.wafflebase");
  });

  test("renders canonical titles and validated inline and block styling", () => {
    const canonicalLayout = {
      alignment: "center",
      lineHeight: 1.5,
      marginTop: 8,
      marginBottom: 8,
      textIndent: 0,
      marginLeft: 0,
    };
    const result = buildStaticWriterDocument(source([
      { id: "title", type: "title", inlines: [{ text: "Synthetic title", style: {} }], style: {} },
      { id: "subtitle", type: "subtitle", inlines: [{ text: "Synthetic subtitle", style: {} }], style: {} },
      { id: "body", type: "paragraph", inlines: [
        { text: "Safe link", style: { href: "https://example.test/document", color: "#123456", backgroundColor: "abc", fontSize: 18, fontFamily: "Synthetic Sans" } },
        { text: "\uFFFC", style: { image: { src: PNG_1X1, alt: "Synthetic image", width: 12, height: 8 } } },
      ], style: canonicalLayout },
      { id: "item", type: "list-item", listKind: "unordered", listLevel: 0,
        inlines: [{ text: "Synthetic item", style: {} }], style: { alignment: "right" } },
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain('<h1 class="writer-title">Synthetic title</h1>');
    expect(result.html).toContain('<h2 class="writer-subtitle">Synthetic subtitle</h2>');
    expect(result.html).toContain('<p style="text-align:center;line-height:1.5;margin-top:8px;margin-bottom:8px;text-indent:0px;margin-left:0px">');
    expect(result.html).toContain('style="font-size:18px;font-family:&quot;Synthetic Sans&quot;;color:#123456;background-color:#abc"');
    expect(result.html).toContain('<li style="text-align:right">Synthetic item</li>');
    expect(result.html).toContain(`src="${PNG_1X1}"`);
    expect(result.warnings).toEqual([]);
  });

  test("renders real nested lists and nested table-cell blocks", () => {
    const result = buildStaticWriterDocument(source([
      { id: "a", type: "list-item", listKind: "unordered", listLevel: 0, inlines: [{ text: "A", style: {} }] },
      { id: "a1", type: "list-item", listKind: "ordered", listLevel: 1, inlines: [{ text: "A.1", style: {} }] },
      { id: "a2", type: "list-item", listKind: "ordered", listLevel: 1, inlines: [{ text: "A.2", style: {} }] },
      { id: "b", type: "list-item", listKind: "unordered", listLevel: 0, inlines: [{ text: "B", style: {} }] },
      { id: "table", type: "table", tableData: { rows: [{ cells: [
        { colSpan: 2, rowSpan: 1, blocks: [paragraph("cell", "Cell <safe>")],
          style: { backgroundColor: "#abc", verticalAlign: "middle", padding: 6 } },
        { colSpan: 0, blocks: [], style: {} },
      ] }] }, inlines: [], style: {} },
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain("<ul><li>A<ol><li>A.1</li><li>A.2</li></ol></li><li>B</li></ul>");
    expect(result.html).toContain('<td colspan="2" style="background-color:#abc;vertical-align:middle;padding:6px"><p>Cell &lt;safe&gt;</p></td>');
  });

  test("allowlists raster data URL syntax and excludes source URLs and declared SVG", () => {
    const png = PNG_1X1;
    const result = buildStaticWriterDocument(source([
      { id: "images", type: "paragraph", inlines: [
        { text: "\uFFFC", style: { image: { src: png, alt: '"><script>alert(1)</script>', width: 10 } } },
        { text: "\uFFFC", style: { image: { src: "https://private.test/image.png" } } },
        { text: "\uFFFC", style: { image: { src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } } },
      ], style: {} },
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain(`src="${png}"`);
    expect(result.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.html).not.toContain("https://private.test");
    expect(result.html).not.toContain("image/svg+xml");
    expect(result.warnings.filter((warning) => warning.code === "unavailable_image")).toHaveLength(2);
  });

  test("escapes hostile text, removes executable links, and contains no source script or handlers", () => {
    const result = buildStaticWriterDocument(source([
      paragraph("hostile", '<img src=x onerror="alert(1)">', { href: "javascript:alert(1)" }),
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain("&lt;img src=x onerror=\"alert(1)\"&gt;");
    expect(result.html).not.toContain("javascript:");
    expect(result.html).not.toMatch(/<[^>]+\sonerror=/i);
    expect(result.html).not.toContain("<script");
    expect(result.warnings.some((warning) => warning.code === "unsafe_link")).toBe(true);
  });

  test("preserves recoverable text from unknown blocks with explicit diagnostics", () => {
    const result = buildStaticWriterDocument(source([
      { id: "quote", type: "future-callout", inlines: [{ text: "Keep this meaning", style: { color: "#f00" } }] },
      { id: "broken", type: "table", tableData: null },
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain("Keep this meaning");
    expect(result.html).toContain("Table content unavailable.");
    expect(result.warnings.map((warning) => warning.code)).toEqual(["unsupported_block", "malformed_structure"]);
  });

  test("retains valid styling and text while warning on invalid and future properties", () => {
    const result = buildStaticWriterDocument(source([
      { id: "mixed", type: "paragraph", inlines: [{ text: "Still readable", style: {
        bold: true, color: "#123456", fontSize: 201, futureEffect: "sparkle",
      } }], style: { alignment: "right", marginTop: -1, futureLayout: true } },
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain('<p style="text-align:right"><strong><span style="color:#123456">Still readable</span></strong></p>');
    expect(result.warnings.map(({ path }) => path)).toEqual([
      "blocks[0].inlines[0].style",
      "blocks[0].inlines[0].style.fontSize",
      "blocks[0].style",
      "blocks[0].style.marginTop",
    ]);
  });

  test("distinguishes non-Writer input from a malformed Writer envelope", () => {
    expect(buildStaticWriterDocument("<html><body>ordinary</body></html>")).toMatchObject({ kind: "not_writer" });
    expect(buildStaticWriterDocument('<script type="application/vnd.nautilo.document+json" id="manifest">{bad</script>'))
      .toMatchObject({ kind: "malformed" });
  });

  test("normalizes malformed list depth with an explicit warning", () => {
    const result = buildStaticWriterDocument(source([
      { id: "deep", type: "list-item", listKind: "ordered", listLevel: 3, inlines: [{ text: "Readable", style: {} }] },
    ]));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.html).toContain("<ol><li>Readable</li></ol>");
    expect(result.warnings.some((warning) => warning.code === "malformed_structure")).toBe(true);
  });
});
