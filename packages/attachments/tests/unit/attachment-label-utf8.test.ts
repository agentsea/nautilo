import { describe, expect, test } from "bun:test";
import { ATTACHMENT_POLICY } from "../../src/policy";
import {
  attachmentFilenameExceedsUtf8Policy,
  attachmentIdExceedsUtf8Policy,
  attachmentLabelExceedsUtf8Policy,
  attachmentLabelUtf8ByteLength,
} from "../../src/attachment-label-utf8";

describe("attachmentLabelUtf8", () => {
  test("ASCII length matches byte length", () => {
    expect(attachmentLabelUtf8ByteLength("abc")).toBe(3);
  });

  test("id policy allows up to maxAttachmentIdUtf8Bytes", () => {
    const s = "a".repeat(ATTACHMENT_POLICY.maxAttachmentIdUtf8Bytes);
    expect(attachmentIdExceedsUtf8Policy(s)).toBe(false);
  });

  test("id policy rejects one byte over cap", () => {
    const s = "a".repeat(ATTACHMENT_POLICY.maxAttachmentIdUtf8Bytes + 1);
    expect(attachmentIdExceedsUtf8Policy(s)).toBe(true);
  });

  test("filename policy allows up to maxAttachmentFilenameUtf8Bytes", () => {
    const s = "b".repeat(ATTACHMENT_POLICY.maxAttachmentFilenameUtf8Bytes);
    expect(attachmentFilenameExceedsUtf8Policy(s)).toBe(false);
  });

  test("filename policy rejects one byte over cap", () => {
    const s = "b".repeat(ATTACHMENT_POLICY.maxAttachmentFilenameUtf8Bytes + 1);
    expect(attachmentFilenameExceedsUtf8Policy(s)).toBe(true);
  });

  test("legacy label helper tracks combined ceiling", () => {
    const ok = "c".repeat(ATTACHMENT_POLICY.maxAttachmentLabelUtf8Bytes);
    expect(attachmentLabelExceedsUtf8Policy(ok)).toBe(false);
    expect(attachmentLabelExceedsUtf8Policy(`${ok}a`)).toBe(true);
  });

  test("counts UTF-8 bytes not code units", () => {
    const s = "é".repeat(200);
    expect(attachmentLabelUtf8ByteLength(s)).toBe(400);
    expect(attachmentFilenameExceedsUtf8Policy(s)).toBe(false);
    const huge = "é".repeat(400);
    expect(attachmentLabelUtf8ByteLength(huge)).toBe(800);
    expect(attachmentFilenameExceedsUtf8Policy(huge)).toBe(true);
  });
});
