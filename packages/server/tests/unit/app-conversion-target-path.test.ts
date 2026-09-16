import { describe, expect, it } from "bun:test";
import { deriveConversionTargetPath } from "../../src/apps/app-routes";

describe("deriveConversionTargetPath (M205)", () => {
  it("swaps the extension on a bare filename", () => {
    expect(deriveConversionTargetPath("report.docx", ".html")).toBe("report.html");
  });

  it("preserves the containing directory", () => {
    expect(deriveConversionTargetPath("notes/report.docx", ".html")).toBe("notes/report.html");
  });

  it("normalizes backslash separators", () => {
    expect(deriveConversionTargetPath("notes\\deep\\report.docx", ".html")).toBe(
      "notes/deep/report.html",
    );
  });

  it("appends the extension when the source has none", () => {
    expect(deriveConversionTargetPath("report", ".docx")).toBe("report.docx");
  });

  it("falls back to 'document' for an empty stem", () => {
    expect(deriveConversionTargetPath(".docx", ".html")).toBe("document.html");
  });

  it("keeps a directory even when the basename has no stem", () => {
    expect(deriveConversionTargetPath("dir/.docx", ".html")).toBe("dir/document.html");
  });
});
