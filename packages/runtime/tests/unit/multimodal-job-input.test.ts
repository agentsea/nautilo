import { describe, expect, test } from "bun:test";
import { ATTACHMENT_POLICY, maxChatImageBase64CharLength } from "@nautilo/attachments";
import { parseMultimodalImagesFromJobInput } from "../../src/executors/multimodal-job-input";

describe("parseMultimodalImagesFromJobInput", () => {
  test("accepts a minimal valid image entry", () => {
    const out = parseMultimodalImagesFromJobInput([
      {
        type: "image",
        attachmentId: "a1",
        filename: "x.png",
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.mimeType).toBe("image/png");
  });

  test("rejects hostile MIME parameters", () => {
    const out = parseMultimodalImagesFromJobInput([
      {
        type: "image",
        attachmentId: "a1",
        filename: "x.png",
        mimeType: "image/png\r\nX:Bad",
        base64: "abcd",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  test("rejects oversize base64", () => {
    const huge = "A".repeat(maxChatImageBase64CharLength() + 1);
    const out = parseMultimodalImagesFromJobInput([
      {
        type: "image",
        attachmentId: "a1",
        filename: "x.png",
        mimeType: "image/png",
        base64: huge,
      },
    ]);
    expect(out).toHaveLength(0);
  });

  test("rejects invalid base64 alphabet", () => {
    const out = parseMultimodalImagesFromJobInput([
      {
        type: "image",
        attachmentId: "a1",
        filename: "x.png",
        mimeType: "image/png",
        base64: "not-valid!!!",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  test("rejects malformed base64 padding", () => {
    const out = parseMultimodalImagesFromJobInput([
      {
        type: "image",
        attachmentId: "a1",
        filename: "x.png",
        mimeType: "image/png",
        base64: "abc",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  test("skips entry when filename exceeds UTF-8 byte policy", () => {
    const longName = "a".repeat(ATTACHMENT_POLICY.maxAttachmentFilenameUtf8Bytes + 1);
    const out = parseMultimodalImagesFromJobInput([
      {
        type: "image",
        attachmentId: "a1",
        filename: longName,
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
      },
    ]);
    expect(out).toHaveLength(0);
  });

  test("skips entry when attachmentId exceeds UTF-8 byte policy", () => {
    const longId = "a".repeat(ATTACHMENT_POLICY.maxAttachmentIdUtf8Bytes + 1);
    const out = parseMultimodalImagesFromJobInput([
      {
        type: "image",
        attachmentId: longId,
        filename: "x.png",
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
      },
    ]);
    expect(out).toHaveLength(0);
  });
});
