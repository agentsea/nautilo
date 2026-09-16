import { describe, expect, test } from "bun:test";
import {
  formatComposerAttachmentSkipToast,
  sanitizeComposerAttachmentBasenameForUi,
} from "../../src/lib/composer-attachment-preflight";

describe("sanitizeComposerAttachmentBasenameForUi", () => {
  test("strips ASCII control characters", () => {
    expect(sanitizeComposerAttachmentBasenameForUi("a\u0000b.pdf")).toBe("ab.pdf");
    expect(sanitizeComposerAttachmentBasenameForUi("x\u007fy")).toBe("xy");
  });

  test("truncates very long names", () => {
    const long = "a".repeat(300);
    expect(sanitizeComposerAttachmentBasenameForUi(long).length).toBeLessThanOrEqual(240);
    expect(sanitizeComposerAttachmentBasenameForUi(long).endsWith("…")).toBe(true);
  });
});

describe("formatComposerAttachmentSkipToast", () => {
  test("sanitizes embedded filenames", () => {
    const { message } = formatComposerAttachmentSkipToast([
      { basename: 'evil\u0008.wav.exe', reason: "unsupported_type" },
    ]);
    expect(message).not.toContain("\u0008");
    expect(message).toContain("evil");
  });
});
