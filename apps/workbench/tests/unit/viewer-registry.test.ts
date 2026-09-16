import { describe, expect, test } from "bun:test";
import { createAuthorizedHumanArtifactViewerByteSource } from "@nautilo/lattice-bridge/client/browser";
import { adapterForFile, viewerKindForPath } from "../../src/viewers/registry";
import { htmlViewerAdapter } from "../../src/viewers/html/adapter";
import { textViewerAdapter } from "../../src/viewers/text/adapter";

describe("viewer registry", () => {
  test("routes images to image viewer", () => {
    expect(viewerKindForPath("/repo/image.png")).toBe("image");
    expect(viewerKindForPath("/repo/photo.jpg")).toBe("image");
    expect(viewerKindForPath("/repo/vector.svg")).toBe("image");
  });

  test("routes markdown to markdown viewer", () => {
    expect(viewerKindForPath("/repo/README.md")).toBe("markdown");
  });

  test("routes HTML files to html viewer", () => {
    expect(viewerKindForPath("/repo/index.html")).toBe("html");
    expect(viewerKindForPath("/repo/page.htm")).toBe("html");
    expect(viewerKindForPath("/repo/slide.nwx.html")).toBe("html");
  });

  test("adapterForFile picks html adapter for .html paths", () => {
    expect(adapterForFile({ kind: "fs", path: "/repo/index.html", rootPath: "/repo" })).toBe(
      htmlViewerAdapter,
    );
  });

  test("routes text/code files to text viewer", () => {
    expect(viewerKindForPath("/repo/app.tsx")).toBe("text");
    expect(viewerKindForPath("/repo/config.json")).toBe("text");
  });

  test("routes PDFs to PDF viewer", () => {
    expect(viewerKindForPath("/repo/report.pdf")).toBe("pdf");
  });

  test("routes DOCX to DOCX viewer", () => {
    expect(viewerKindForPath("/repo/report.docx")).toBe("docx");
  });

  test("routes XLSX to XLSX viewer", () => {
    expect(viewerKindForPath("/repo/report.xlsx")).toBe("xlsx");
  });

  test("routes PPTX to PPTX viewer", () => {
    expect(viewerKindForPath("/repo/deck.pptx")).toBe("pptx");
  });

  test("unknown binary-ish files fall back", () => {
    expect(viewerKindForPath("/repo/legacy.ppt")).toBe("fallback");
    expect(viewerKindForPath("/repo/macro.pptm")).toBe("fallback");
    expect(viewerKindForPath("/repo/open.odp")).toBe("fallback");
    expect(viewerKindForPath("/repo/archive.zip")).toBe("fallback");
  });

  test("explicit protected Artifact bytes reach a bounded existing viewer", async () => {
    const opened: unknown[] = [];
    const detail = {
      artifactId: "82000000-0000-4000-8000-000000000001",
      artifactRevision: 1,
      cryptoAccessRevision: 0,
      requiredNamespaceIds: ["82000000-0000-4000-8000-000000000002"],
      logicalPath: "notes/readme.txt",
      mimeType: "text/plain",
      plaintextLength: 22,
      mimeClass: "text" as const,
      sizeBucket: "le_64_kib" as const,
      archived: false,
      canManageAccess: true,
    };
    const artifactBytes = createAuthorizedHumanArtifactViewerByteSource({
      detail: () => Promise.resolve(detail),
      withOpenedRange: async (input) => {
        opened.push({
          artifactId: input.artifactId,
          start: input.start,
          endExclusive: input.endExclusive,
        });
        return input.consume(
          new TextEncoder().encode("protected viewer bytes"),
          detail,
        );
      },
    });
    const result = await textViewerAdapter.load({
      kind: "artifact",
      id: "82000000-0000-4000-8000-000000000001",
      path: "notes/readme.txt",
      mimeType: "text/plain",
    }, {
      maxTextBytes: 64,
      artifactBytes,
    });

    expect(result).toEqual({
      kind: "ready",
      data: { content: "protected viewer bytes", language: null },
    });
    expect(opened).toEqual([{
      artifactId: "82000000-0000-4000-8000-000000000001",
      start: 0,
      endExclusive: 22,
    }]);
  });
});
