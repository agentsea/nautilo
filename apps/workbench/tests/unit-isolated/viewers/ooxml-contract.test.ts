import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { preflightOoxmlArchive } from "../../../src/viewers/ooxml/archive-preflight";
import {
  OOXML_ARCHIVE_PREFLIGHT_LIMITS,
  OOXML_MAX_ARCHIVE_ENTRIES,
  OOXML_MAX_DECLARED_PER_ENTRY_UNCOMPRESSED_BYTES,
  OOXML_MAX_DECLARED_TOTAL_UNCOMPRESSED_BYTES,
  OOXML_MAX_SOURCE_BYTES,
  OOXML_PARSER_CONTRACT,
  OOXML_PARSER_WASM_FILES,
  OOXML_0750_RUNTIME_INVENTORY,
  OOXML_SAFE_LOAD_OPTIONS,
  OOXML_SAFE_VIEWER_OPTIONS,
  OOXML_TOTAL_LOAD_TIMEOUT_MS,
  OOXML_WORKER_TIMEOUT_MS,
  PPTX_SAFE_VIEWER_OPTIONS,
} from "../../../src/viewers/ooxml/contract";

const SMOKE_FIXTURES = {
  docx: "sample.docx",
  xlsx: "sample.xlsx",
  pptx: "sample.pptx",
} as const;

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

describe("Silurus 0.75.x direct-subpath contract", () => {
  test("keeps the version-grounded privacy and resource options explicit", () => {
    expect(OOXML_SAFE_LOAD_OPTIONS).toEqual({
      useGoogleFonts: false,
      resourceLimits: {
        maxArchiveEntryBytes: 64 * 1024 * 1024,
        maxTotalInflatedBytes: 512 * 1024 * 1024,
      },
      workerTimeoutMs: 30_000,
    });
    expect(OOXML_SAFE_VIEWER_OPTIONS).toEqual({ enableHyperlinks: false });
    expect(PPTX_SAFE_VIEWER_OPTIONS).toEqual({ enableMediaPlayback: false });
  });

  test("finds all three current parser entry points and package WASM filenames", () => {
    expect(typeof OOXML_PARSER_CONTRACT.docx.load).toBe("function");
    expect(typeof OOXML_PARSER_CONTRACT.xlsx.load).toBe("function");
    expect(typeof OOXML_PARSER_CONTRACT.pptx.load).toBe("function");
    expect(OOXML_PARSER_WASM_FILES).toEqual({
      docx: "docx_parser_bg.wasm",
      xlsx: "xlsx_parser_bg.wasm",
      pptx: "pptx_parser_bg.wasm",
    });
    expect(OOXML_0750_RUNTIME_INVENTORY).toMatchObject({
      packageVersion: "0.75.0",
      defaults: {
        useGoogleFonts: false,
        resourceLimits: {
          maxArchiveEntryBytes: 128 * 1024 * 1024,
          maxTotalInflatedBytes: 256 * 1024 * 1024,
        },
        workerTimeoutMs: "unlimited (initial parser request only)",
        enableHyperlinks: true,
        enableMediaPlayback: false,
      },
      configured: {
        useGoogleFonts: false,
        resourceLimits: {
          maxArchiveEntryBytes: 64 * 1024 * 1024,
          maxTotalInflatedBytes: 512 * 1024 * 1024,
        },
        workerTimeoutMs: 30_000,
        enableHyperlinks: false,
        enableMediaPlayback: false,
      },
      workerModeRenderHosts: {
        docx: "render-worker-host-DZ4u0RFs.js",
        xlsx: "render-worker-host-CLdOlxFu.js",
        pptx: "render-worker-host-s3J-mWBP.js",
      },
      parserWasm: OOXML_PARSER_WASM_FILES,
    });
  });

  test("reads the existing smoke OOXML fixtures as independent raw ArrayBuffers", async () => {
    for (const [format, filename] of Object.entries(SMOKE_FIXTURES)) {
      const path = resolve(
        REPO_ROOT,
        "apps/desktop/scratch/d362-spike/sample",
        filename,
      );
      const bytes = await Bun.file(path).arrayBuffer();
      const text = new TextDecoder().decode(bytes);

      expect(bytes).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(bytes).slice(0, 2)).toEqual(
        new Uint8Array([0x50, 0x4b]),
      );
      expect(text).toContain("[Content_Types].xml");
      expect(text).toContain(
        format === "docx"
          ? "word/document.xml"
          : format === "xlsx"
            ? "xl/workbook.xml"
            : "ppt/presentation.xml",
      );
      expect(
        preflightOoxmlArchive(bytes, OOXML_ARCHIVE_PREFLIGHT_LIMITS),
      ).toMatchObject({ ok: true });
    }
  });

  test("pins the shared source and host limits", () => {
    expect(OOXML_MAX_SOURCE_BYTES).toBe(100 * 1024 * 1024);
    expect(OOXML_MAX_ARCHIVE_ENTRIES).toBe(20_000);
    expect(OOXML_MAX_DECLARED_PER_ENTRY_UNCOMPRESSED_BYTES).toBe(
      64 * 1024 * 1024,
    );
    expect(OOXML_MAX_DECLARED_TOTAL_UNCOMPRESSED_BYTES).toBe(512 * 1024 * 1024);
    expect(OOXML_ARCHIVE_PREFLIGHT_LIMITS).toEqual({
      maxEntries: OOXML_MAX_ARCHIVE_ENTRIES,
      maxDeclaredTotalUncompressedBytes: BigInt(
        OOXML_MAX_DECLARED_TOTAL_UNCOMPRESSED_BYTES,
      ),
      maxDeclaredPerEntryUncompressedBytes: BigInt(
        OOXML_MAX_DECLARED_PER_ENTRY_UNCOMPRESSED_BYTES,
      ),
    });
    expect(OOXML_SAFE_LOAD_OPTIONS.resourceLimits).toEqual({
      maxArchiveEntryBytes: OOXML_MAX_DECLARED_PER_ENTRY_UNCOMPRESSED_BYTES,
      maxTotalInflatedBytes: OOXML_MAX_DECLARED_TOTAL_UNCOMPRESSED_BYTES,
    });
    expect(OOXML_SAFE_LOAD_OPTIONS.workerTimeoutMs).toBe(
      OOXML_WORKER_TIMEOUT_MS,
    );
    expect(OOXML_TOTAL_LOAD_TIMEOUT_MS).toBeGreaterThan(
      OOXML_WORKER_TIMEOUT_MS,
    );
  });
});
