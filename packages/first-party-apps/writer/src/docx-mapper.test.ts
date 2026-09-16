import { describe, expect, test } from "bun:test";
import {
  mapOfficeCliGetEnvelope,
  mapWriterDocumentToOfficeCliBatch,
  type OfficeCliGetEnvelope,
} from "./docx-mapper";
import { OFFICE_RUN_IMAGE_INDEX_PROP, TINY_PNG_DATA_URL, WRITER_IMAGE_OBJECT_CHAR } from "./docx-image";

describe("writer docx-mapper", () => {
  test("mapOfficeCliGetEnvelope maps a minimal body to blocks", () => {
    const envelope: OfficeCliGetEnvelope = {
      success: true,
      data: {
        matches: 1,
        results: [
          {
            path: "/body",
            type: "body",
            children: [
              {
                path: "/body/p[1]",
                type: "paragraph",
                children: [
                  {
                    path: "/body/p[1]/r[1]",
                    type: "run",
                    text: "Hello DOCX",
                    format: { italic: true },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const result = mapOfficeCliGetEnvelope(envelope);

    expect(result.skipped).toHaveLength(0);
    expect(result.document.blocks.length).toBeGreaterThanOrEqual(1);
    expect(result.document.blocks[0]?.type).toBe("paragraph");
  });

  test("mapWriterDocumentToOfficeCliBatch maps a paragraph to commands", () => {
    const result = mapWriterDocumentToOfficeCliBatch({
      blocks: [
        {
          id: "block-1",
          type: "paragraph",
          inlines: [
            { text: "Hello ", style: {} },
            { text: "Office", style: { bold: true } },
          ],
          style: {
            alignment: "left",
            lineHeight: 1.5,
            marginTop: 0,
            marginBottom: 8,
            textIndent: 0,
            marginLeft: 0,
          },
        },
      ],
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.commands.length).toBeGreaterThan(0);
  });

  test("mapWriterDocumentToOfficeCliBatch maps image inline to picture command + imageInputs", () => {
    const result = mapWriterDocumentToOfficeCliBatch({
      blocks: [
        {
          id: "block-img",
          type: "paragraph",
          inlines: [
            { text: "Before ", style: {} },
            {
              text: WRITER_IMAGE_OBJECT_CHAR,
              style: { image: { src: TINY_PNG_DATA_URL, width: 96, height: 96, alt: "dot" } },
            },
            { text: " after", style: {} },
          ],
          style: {
            alignment: "left",
            lineHeight: 1.5,
            marginTop: 0,
            marginBottom: 8,
            textIndent: 0,
            marginLeft: 0,
          },
        },
      ],
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.imageInputs).toHaveLength(1);
    expect(result.imageInputs[0]?.dataUrl).toBe(TINY_PNG_DATA_URL);
    const picture = result.commands.find((cmd) => cmd.type === "picture");
    expect(picture).toBeDefined();
    expect(picture!.props[OFFICE_RUN_IMAGE_INDEX_PROP]).toBe("0");
    expect(picture!.props["alt"]).toBe("dot");
    expect(result.commands.some((cmd) => cmd.type === "r" && cmd.props["text"] === WRITER_IMAGE_OBJECT_CHAR)).toBe(false);
  });

  test("mapOfficeCliGetEnvelope maps picture node to image inline with data URL", () => {
    const envelope: OfficeCliGetEnvelope = {
      success: true,
      data: {
        matches: 1,
        results: [
          {
            path: "/body",
            type: "body",
            children: [
              {
                path: "/body/p[1]",
                type: "paragraph",
                children: [
                  {
                    path: "/body/p[1]/r[1]",
                    type: "run",
                    text: "Hi ",
                    format: {},
                  },
                  {
                    path: "/body/p[1]/r[2]",
                    type: "picture",
                    text: "dot",
                    format: {
                      relId: "Rabc123",
                      width: "2.0cm",
                      height: "2.0cm",
                      alt: "dot",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const result = mapOfficeCliGetEnvelope(envelope, {
      resolveMedia: (relId) =>
        relId === "Rabc123" ? { dataUrl: TINY_PNG_DATA_URL } : null,
    });

    expect(result.skipped).toHaveLength(0);
    const block = result.document.blocks[0];
    expect(block?.inlines).toHaveLength(2);
    const imageInline = block?.inlines[1];
    expect(imageInline?.text).toBe(WRITER_IMAGE_OBJECT_CHAR);
    expect(imageInline?.style.image?.src).toBe(TINY_PNG_DATA_URL);
    expect(imageInline?.style.image?.alt).toBe("dot");
  });

  test("mapOfficeCliGetEnvelope records skip when picture media is missing", () => {
    const envelope: OfficeCliGetEnvelope = {
      success: true,
      data: {
        matches: 1,
        results: [
          {
            path: "/body",
            type: "body",
            children: [
              {
                path: "/body/p[1]",
                type: "paragraph",
                children: [
                  {
                    path: "/body/p[1]/r[1]",
                    type: "picture",
                    format: { relId: "Rmissing" },
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const result = mapOfficeCliGetEnvelope(envelope, {
      resolveMedia: () => null,
    });

    expect(result.skipped.some((entry) => entry.type === "picture")).toBe(true);
  });
});
