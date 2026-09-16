/**
 * D362 §3.5.2 — guards the committed blank-document templates that
 * `POST /api/office/new` copies. These were minted once by LibreOffice; if
 * one goes missing, is renamed, or is truncated, "New" silently 500s. This
 * test asserts each template exists and is a valid OOXML package (a ZIP whose
 * `[Content_Types].xml` names the expected part), independent of any DB.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "assets", "office-templates");

const CASES = [
  { file: "blank.docx", contentTypeMarker: "wordprocessingml" },
  { file: "blank.xlsx", contentTypeMarker: "spreadsheetml" },
  { file: "blank.pptx", contentTypeMarker: "presentationml" },
] as const;

describe("office blank templates", () => {
  for (const { file, contentTypeMarker } of CASES) {
    test(`${file} exists and is a valid OOXML package`, async () => {
      const bytes = await readFile(join(TEMPLATES_DIR, file));
      // OOXML files are ZIP archives → PK\x03\x04 magic.
      expect(bytes.byteLength).toBeGreaterThan(1000);
      expect(bytes[0]).toBe(0x50); // 'P'
      expect(bytes[1]).toBe(0x4b); // 'K'

      const entries = unzipSync(new Uint8Array(bytes));
      const contentTypes = entries["[Content_Types].xml"];
      expect(contentTypes, `${file} must contain [Content_Types].xml`).toBeDefined();
      expect(strFromU8(contentTypes!)).toContain(contentTypeMarker);
    });
  }
});
