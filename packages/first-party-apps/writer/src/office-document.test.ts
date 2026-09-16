import { describe, expect, test } from "bun:test";
import { installWriterTestDom } from "./test-dom";

installWriterTestDom();

import { TINY_PNG_DATA_URL, WRITER_IMAGE_OBJECT_CHAR } from "./docx-image";
import {
  buildDocumentPreviewHtml,
  collectWriterPreviewImageSources,
  createDefaultManifest,
  createEmptyWriterHtml,
  parseWriterHtml,
  serializeWriterHtml,
  WAFFLEBASE_DOCUMENT_TYPE,
  WRITER_PREVIEW_IMAGE_INDEX_ATTR,
  type WafflebaseDocumentPayload,
} from "./office-document";
import {
  extractWriterPreviewImageSourcesFromHtml,
  hydrateWriterPreviewImages,
} from "./writer-preview-hydration";

const sampleDoc: WafflebaseDocumentPayload = {
  blocks: [
    { id: "b1", type: "heading", headingLevel: 1, inlines: [{ text: "Title", style: {} }], style: {} },
    { id: "b2", type: "paragraph", inlines: [{ text: "Hello world", style: {} }], style: {} },
  ],
};

const tableDoc: WafflebaseDocumentPayload = {
  blocks: [
    {
      id: "t1",
      type: "table",
      inlines: [],
      style: {},
      tableData: {
        columnWidths: [120, 120],
        rows: [
          {
            cells: [
              {
                blocks: [
                  {
                    id: "c1",
                    type: "paragraph",
                    inlines: [{ text: "A1", style: {} }],
                    style: {},
                  },
                ],
                style: {},
              },
              {
                blocks: [
                  {
                    id: "c2",
                    type: "paragraph",
                    inlines: [{ text: "B1", style: {} }],
                    style: {},
                  },
                ],
                style: {},
              },
            ],
          },
        ],
      },
    },
  ],
};

const imageDoc: WafflebaseDocumentPayload = {
  blocks: [
    {
      id: "p1",
      type: "paragraph",
      inlines: [
        {
          text: WRITER_IMAGE_OBJECT_CHAR,
          style: {
            image: {
              src: TINY_PNG_DATA_URL,
              width: 16,
              height: 16,
              alt: "Tiny",
            },
          },
        },
      ],
      style: {},
    },
  ],
};

describe("writer office-document container", () => {
  test("round-trips a document deterministically", () => {
    const html = serializeWriterHtml(createDefaultManifest(), sampleDoc);
    const parsed = parseWriterHtml(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.document.blocks).toHaveLength(2);
    const html2 = serializeWriterHtml(parsed.document.manifest, parsed.document.document);
    expect(html2).toBe(html);
  });

  test("empty document parses back to zero blocks", () => {
    const parsed = parseWriterHtml(createEmptyWriterHtml());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document.document.blocks).toHaveLength(0);
  });

  test("rejects executable script tags", () => {
    const html = serializeWriterHtml(createDefaultManifest(), sampleDoc).replace(
      "</head>",
      '<script>alert(1)</script></head>',
    );
    const parsed = parseWriterHtml(html);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("executable script");
  });

  test("rejects prototype-pollution keys in the payload", () => {
    const evil = `<!DOCTYPE html><html><head>
<script type="application/vnd.nautilo.document+json" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
<script type="${WAFFLEBASE_DOCUMENT_TYPE}" id="wafflebase-document">{"blocks":[],"__proto__":{"x":1}}</script>
</head><body></body></html>`;
    const parsed = parseWriterHtml(evil);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("forbidden key");
  });

  test("rejects a payload without a blocks array", () => {
    const html = `<!DOCTYPE html><html><head>
<script type="application/vnd.nautilo.document+json" id="manifest">${JSON.stringify(createDefaultManifest())}</script>
<script type="${WAFFLEBASE_DOCUMENT_TYPE}" id="wafflebase-document">{"notBlocks":true}</script>
</head><body></body></html>`;
    const parsed = parseWriterHtml(html);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("blocks array");
  });
});

describe("writer rich preview html", () => {
  test("emits semantic table markup with escaped cell text", () => {
    const preview = buildDocumentPreviewHtml(tableDoc);
    expect(preview).toContain("<table>");
    expect(preview).toContain("<tr>");
    expect(preview).toContain("<td>");
    expect(preview).toContain(">A1<");
    expect(preview).toContain(">B1<");
  });

  test("keeps text-only behavior for normal blocks", () => {
    const preview = buildDocumentPreviewHtml(sampleDoc);
    expect(preview).toContain("<h1>Title</h1>");
    expect(preview).toContain("<p>Hello world</p>");
  });

  test("emits indexed image slots without data URLs in preview body", () => {
    const html = serializeWriterHtml(createDefaultManifest(), imageDoc);
    const bodyStart = html.indexOf("<body>");
    const body = html.slice(bodyStart);
    expect(body).toContain(`${WRITER_PREVIEW_IMAGE_INDEX_ATTR}="0"`);
    expect(body).toContain('alt="Tiny"');
    expect(body).not.toContain("base64,");
    expect(body).not.toContain(TINY_PNG_DATA_URL);
    expect(collectWriterPreviewImageSources(imageDoc)).toEqual([TINY_PNG_DATA_URL]);
  });

  test("escapes XSS payloads in preview text", () => {
    const evil: WafflebaseDocumentPayload = {
      blocks: [
        {
          id: "x",
          type: "paragraph",
          inlines: [{ text: '<img src=x onerror="alert(1)">', style: {} }],
          style: {},
        },
      ],
    };
    const preview = buildDocumentPreviewHtml(evil);
    expect(preview).toContain("&lt;img");
    expect(preview).not.toContain("<img src=x");
  });
});

describe("writer preview hydration", () => {
  test("hydration attaches valid blob URLs and revokes them", () => {
    const html = serializeWriterHtml(createDefaultManifest(), imageDoc);
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const preview = doc.querySelector("main.nautilo-writer-preview");
    expect(preview).not.toBeNull();
    if (preview === null) return;
    const result = hydrateWriterPreviewImages(preview, collectWriterPreviewImageSources(imageDoc));
    expect(result.attached).toBe(1);
    const img = preview.querySelector(`img[${WRITER_PREVIEW_IMAGE_INDEX_ATTR}="0"]`) as HTMLImageElement;
    const blobUrl = img.src;
    expect(blobUrl.startsWith("blob:")).toBe(true);
    expect(() => result.revoke()).not.toThrow();
    expect(blobUrl.startsWith("blob:")).toBe(true);
  });

  test("ignores invalid image payloads and keeps fallback visible", () => {
    const invalidDoc: WafflebaseDocumentPayload = {
      blocks: [
        {
          id: "p1",
          type: "paragraph",
          inlines: [
            {
              text: WRITER_IMAGE_OBJECT_CHAR,
              style: { image: { src: "data:image/png;base64,%%%", width: 10, height: 10 } },
            },
          ],
          style: {},
        },
      ],
    };
    const html = serializeWriterHtml(createDefaultManifest(), invalidDoc);
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const preview = doc.querySelector("main.nautilo-writer-preview");
    expect(preview).not.toBeNull();
    if (preview === null) return;
    const result = hydrateWriterPreviewImages(preview, collectWriterPreviewImageSources(invalidDoc));
    expect(result.attached).toBe(0);
    const img = preview.querySelector(`img[${WRITER_PREVIEW_IMAGE_INDEX_ATTR}="0"]`) as HTMLImageElement;
    expect(img.src).toBe("");
    const fallback = preview.querySelector(".nautilo-writer-preview-image-fallback");
    expect(fallback).not.toBeNull();
    if (fallback instanceof HTMLElement) expect(fallback.hidden).toBe(false);
  });

  test("static fallback renders without hydration", () => {
    const preview = buildDocumentPreviewHtml(imageDoc);
    expect(preview).toContain("Image preview unavailable");
    expect(preview).not.toContain("src=");
  });

  test("extractWriterPreviewImageSourcesFromHtml reads payload script only", () => {
    const html = serializeWriterHtml(createDefaultManifest(), imageDoc);
    expect(extractWriterPreviewImageSourcesFromHtml(html)).toEqual([TINY_PNG_DATA_URL]);
    expect(extractWriterPreviewImageSourcesFromHtml("<html><body><p>nope</p></body></html>")).toBeNull();
  });
});
