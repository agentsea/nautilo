import { describe, expect, test } from "bun:test";
import { OOXML_TOTAL_LOAD_TIMEOUT_MS, OOXML_WORKER_TIMEOUT_MS } from "../../../src/viewers/ooxml/contract";
import { buildOoxmlLoadOptions, buildOoxmlViewerOptions, OOXML_RUNTIME_LIMITS, sanitizeOoxmlError } from "../../../src/viewers/ooxml/runtime";

describe("OOXML runtime contract", () => {
  test("uses installed safe options and direct-entry relative WASM delivery", () => {
    expect(buildOoxmlLoadOptions()).toEqual({
      useGoogleFonts: false,
      resourceLimits: {
        maxArchiveEntryBytes: 64 * 1024 * 1024,
        maxTotalInflatedBytes: 512 * 1024 * 1024,
      },
      workerTimeoutMs: OOXML_WORKER_TIMEOUT_MS,
      mode: "main",
    });
    expect(buildOoxmlViewerOptions("docx")).toMatchObject({ enableHyperlinks: false, useGoogleFonts: false });
    expect(buildOoxmlViewerOptions("pptx")).toMatchObject({ enableHyperlinks: false, enableMediaPlayback: false });
    expect(OOXML_RUNTIME_LIMITS).toEqual({ workerTimeoutMs: OOXML_WORKER_TIMEOUT_MS, totalLoadTimeoutMs: OOXML_TOTAL_LOAD_TIMEOUT_MS, wasmStrategy: "direct-subpath-relative" });
  });

  test("maps private parser failures to bounded public messages", () => {
    expect(sanitizeOoxmlError(new Error("https://private.example/secret.docx"))).toBe("Unable to preview this document.");
    expect(sanitizeOoxmlError({ code: "encrypted" })).toBe("This document is encrypted and cannot be previewed.");
    expect(sanitizeOoxmlError({ code: "ooxml-resource-limit" })).toBe("This document exceeds the preview safety limit.");
  });
});
