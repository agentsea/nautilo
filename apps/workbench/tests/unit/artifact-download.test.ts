import { describe, expect, test } from "bun:test";
import { prepareArtifactDownload } from "../../src/lib/artifact-download";
import { createDefaultManifest, parseWriterHtml, serializeWriterHtml } from "../../../../packages/first-party-apps/writer/src/office-document";

describe("Writer artifact download", () => {
  test("repairs old linkless previews from preserved URLs without changing source bytes or document data", async () => {
    const doc = { blocks: [{ id: "source", type: "paragraph", style: {}, inlines: [{ text: "Research source", style: { href: "https://example.com/source?q=1&x=2#section" } }] }] };
    const html = serializeWriterHtml(createDefaultManifest(), doc);
    const old = html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, "$1");
    const original = new Blob([old], { type: "text/html" });
    const result = await prepareArtifactDownload(original, "document.html");
    expect(await result.text()).toBe(html);
    expect(await original.text()).toBe(old);
    const parsed = parseWriterHtml(await result.text());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document.document).toEqual(doc);
  });

  test("leaves unrelated HTML, malformed containers and non-HTML bytes unchanged", async () => {
    for (const [content, name] of [["<p>ordinary HTML</p>", "page.html"], ["application/vnd.wafflebase.document+json", "broken.html"], ["binary", "file.docx"]]) {
      const blob = new Blob([content]);
      expect(await prepareArtifactDownload(blob, name)).toBe(blob);
    }
  });
});
