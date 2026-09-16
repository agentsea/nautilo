/**
 * Writer DOCX image round-trip — real OfficeCLI when vendored binary is present.
 * Non-DB-mutating: uses temp files only.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveOfficeCliOrNull } from "../../../config/src/officecli/provisioning.ts";
import { describe, expect, test } from "bun:test";
import { docxMediaMapToDataUrls, extractDocxMediaByRelId, stageOfficeRunImageInputs } from "../../../config/src/officecli/office-run-images.ts";
import {
  mapOfficeCliGetEnvelope,
  mapWriterDocumentToOfficeCliBatch,
} from "../src/docx-mapper";
import { TINY_PNG_DATA_URL, WRITER_IMAGE_OBJECT_CHAR } from "../src/docx-image";

const OFFICECLI = resolveOfficeCliOrNull({ repoRoot: resolve(import.meta.dirname, "../../../..") });

describe("writer docx image round-trip (officecli integration)", () => {
  test.skipIf(!OFFICECLI)("export picture command produces importable picture node + media bytes", async () => {
    if (!OFFICECLI) throw new Error("OfficeCLI unavailable");

    const scratch = await mkdtemp(join(tmpdir(), "writer-docx-image-it-"));
    const docxPath = join(scratch, "image-roundtrip.docx");
    try {
      const mapped = mapWriterDocumentToOfficeCliBatch({
        blocks: [
          {
            id: "p1",
            type: "paragraph",
            inlines: [
              { text: "Hello ", style: {} },
              {
                text: WRITER_IMAGE_OBJECT_CHAR,
                style: { image: { src: TINY_PNG_DATA_URL, width: 96, height: 96, alt: "dot" } },
              },
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
      expect(mapped.imageInputs).toHaveLength(1);
      const staged = await stageOfficeRunImageInputs(mapped.commands, mapped.imageInputs, join(scratch, "images"));
      expect("error" in staged).toBe(false);
      if ("error" in staged) return;

      expect(Bun.spawnSync([OFFICECLI, "create", docxPath, "--type", "docx", "--locale", "en-US", "--force", "--json"]).exitCode).toBe(0);
      expect(Bun.spawnSync([
        OFFICECLI,
        "batch",
        docxPath,
        "--commands",
        JSON.stringify(staged.resolvedOps),
        "--stop-on-error",
        "--json",
      ]).exitCode).toBe(0);
      expect(Bun.spawnSync([OFFICECLI, "close", docxPath, "--json"]).exitCode).toBe(0);
      await staged.cleanup();

      const get = Bun.spawnSync([OFFICECLI, "get", docxPath, "/body", "--depth", "6", "--json"]);
      expect(get.exitCode).toBe(0);
      const envelope = JSON.parse(get.stdout.toString());
      const docxBytes = await readFile(docxPath);
      const mediaByRelId = docxMediaMapToDataUrls(extractDocxMediaByRelId(docxBytes));
      expect(Object.keys(mediaByRelId).length).toBeGreaterThan(0);

      const imported = mapOfficeCliGetEnvelope(envelope, {
        resolveMedia: (relId) => {
          const dataUrl = mediaByRelId[relId];
          return dataUrl ? { dataUrl } : null;
        },
      });
      expect(imported.skipped.filter((s) => s.type === "picture")).toHaveLength(0);
      const inline = imported.document.blocks[0]?.inlines.find((i) => i.text === WRITER_IMAGE_OBJECT_CHAR);
      expect(inline?.style.image?.src.startsWith("data:image/png;base64,")).toBe(true);
      expect(inline?.style.image?.alt).toBe("dot");
      expect(
        imported.document.blocks[0]?.inlines.some((i) => i.text === WRITER_IMAGE_OBJECT_CHAR && !i.style.image),
      ).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});
