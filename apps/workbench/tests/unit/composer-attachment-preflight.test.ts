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

import { isComposerImageAttachment, imageAttachmentModelError, IMAGE_HISTORY_NOTICE } from "@nautilo/attachments/composer-chat-extensions";
describe("image capability feedback", () => {
  test("recognizes image names and server MIME without blocking text or audio", () => {
    expect(isComposerImageAttachment("PHOTO.PNG")).toBe(true);
    expect(isComposerImageAttachment("renamed.txt", "image/jpeg")).toBe(true);
    expect(isComposerImageAttachment("notes.md", "text/plain")).toBe(false);
    expect(isComposerImageAttachment("recording.wav", "audio/wav")).toBe(false);
  });
  test("explains both queued-image recovery choices and the history limitation", () => {
    expect(imageAttachmentModelError("GLM 5.3")).toContain("Remove them or choose a model that supports images");
    expect(IMAGE_HISTORY_NOTICE).toContain("Previous text and answers are still available");
  });
});
