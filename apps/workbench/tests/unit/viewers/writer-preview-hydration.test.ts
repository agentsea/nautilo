import { serializeCanonicalWriterHtml, parseWriterHtml } from "@nautilo/writer-proposal-core";
import { describe, expect, test } from "bun:test";
import {
  createDefaultManifest,
  serializeWriterHtml,
  type WafflebaseDocumentPayload,
} from "../../../../../packages/first-party-apps/writer/src/office-document";
import { TINY_PNG_DATA_URL, WRITER_IMAGE_OBJECT_CHAR } from "../../../../../packages/first-party-apps/writer/src/docx-image";
import { buildCsp } from "../../../src/viewers/html/csp";
import { buildSrcdoc } from "../../../src/viewers/html/srcdoc";
import {
  renderWriterPreview,
  shouldInjectWriterPreviewHydration,
  writerPreviewHydrationScript,
} from "../../../src/viewers/html/writer-preview";

const writerDoc: WafflebaseDocumentPayload = {
  blocks: [
    {
      id: "p1",
      type: "paragraph",
      inlines: [
        {
          text: WRITER_IMAGE_OBJECT_CHAR,
          style: { image: { src: TINY_PNG_DATA_URL, width: 8, height: 8, alt: "dot" } },
        },
      ],
      style: {},
    },
  ],
};

describe("workbench writer preview host seam", () => {
  test("detects Writer HTML for hydration injection", () => {
    const html = serializeWriterHtml(createDefaultManifest(), writerDoc);
    expect(shouldInjectWriterPreviewHydration(html)).toBe(true);
    expect(shouldInjectWriterPreviewHydration("<p>plain</p>")).toBe(false);
  });

  test("buildSrcdoc injects trusted hydration script without duplicating preview body data URLs", () => {
    const html = serializeWriterHtml(createDefaultManifest(), writerDoc);
    const srcDoc = buildSrcdoc(html, buildCsp(), undefined, [writerPreviewHydrationScript()]);
    expect(srcDoc).toContain("readPayload(document)");
    const previewStart = srcDoc.indexOf('<main class="nautilo-writer-preview">');
    const previewEnd = srcDoc.indexOf("</main>", previewStart);
    expect(previewStart).toBeGreaterThan(-1);
    expect(previewEnd).toBeGreaterThan(previewStart);
    const previewBody = srcDoc.slice(previewStart, previewEnd);
    expect(previewBody).toContain('data-writer-image-index="0"');
    expect(previewBody).not.toContain(TINY_PNG_DATA_URL);
    expect(previewBody).not.toContain("base64,");
    expect(srcDoc).toContain(TINY_PNG_DATA_URL);
  });
});


test("Reader renders the saved canonical payload after proposal acceptance removed the static body", () => {
  const payload = { blocks: [{ id: "accepted", type: "paragraph", style: {},
    inlines: [{ text: "Alpha beta delta.", style: {} }] }], retainedField: { future: true } };
  const original = serializeCanonicalWriterHtml(createDefaultManifest(), payload);
  expect(original).toContain("<body></body>");
  const preview = renderWriterPreview(original);
  expect(preview).toContain("<p>Alpha beta delta.</p>");
  expect(parseWriterHtml(preview)).toEqual(parseWriterHtml(original));
  expect(original).toContain("<body></body>");
  expect(renderWriterPreview("<p>ordinary HTML</p>")).toBe("<p>ordinary HTML</p>");
});
