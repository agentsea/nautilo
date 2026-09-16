import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
  extractDocxMediaByRelId,
  OFFICE_RUN_IMAGE_INDEX_PROP,
  stageOfficeRunImageInputs,
} from "../../src/officecli/office-run-images";

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("office-run-images", () => {
  test("extractDocxMediaByRelId maps DOCX relationships to embedded image bytes", () => {
    const pngBytes = Buffer.from(TINY_PNG_DATA_URL.split(",", 2)[1]!, "base64");
    const relationships = new TextEncoder().encode(`<?xml version="1.0" encoding="utf-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
          Target="/media/image.png"
          Id="Rimage1"
        />
      </Relationships>`);
    const docxBytes = Buffer.from(zipSync({
      "word/_rels/document.xml.rels": relationships,
      "media/image.png": pngBytes,
    }));

    const media = extractDocxMediaByRelId(docxBytes);

    expect(media.size).toBe(1);
    expect(media.get("Rimage1")).toEqual({
      bytes: pngBytes,
      mimeType: "image/png",
      dataUrl: TINY_PNG_DATA_URL,
    });
  });

  test("stageOfficeRunImageInputs writes decoded bytes and resolves picture paths", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "office-run-images-test-"));
    try {
      const staged = await stageOfficeRunImageInputs(
        [{
          command: "add",
          parent: "/body/p[1]",
          type: "picture",
          props: { [OFFICE_RUN_IMAGE_INDEX_PROP]: "0", width: "2cm", height: "2cm" },
        }],
        [{ dataUrl: TINY_PNG_DATA_URL }],
        scratch,
      );
      expect("error" in staged).toBe(false);
      if ("error" in staged) return;
      expect(staged.stagedPaths).toHaveLength(1);
      const bytes = await readFile(staged.stagedPaths[0]!);
      expect(bytes.byteLength).toBeGreaterThan(0);
      const resolved = staged.resolvedOps[0] as { props?: Record<string, string> };
      expect(resolved.props?.["path"]).toBe(staged.stagedPaths[0]);
      expect(resolved.props?.[OFFICE_RUN_IMAGE_INDEX_PROP]).toBeUndefined();
      await staged.cleanup();
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  });
});
