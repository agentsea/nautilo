import { describe, expect, test } from "bun:test";
import {
  OFFICE_RUN_IMAGE_INDEX_PROP,
  TINY_PNG_DATA_URL,
  WRITER_IMAGE_OBJECT_CHAR,
  bytesToDataUrl,
  isWriterImageInline,
  parseDataUrlImage,
  validateDataUrlImage,
} from "./docx-image";

describe("writer docx-image", () => {
  test("parseDataUrlImage accepts a tiny PNG data URL", () => {
    const parsed = parseDataUrlImage(TINY_PNG_DATA_URL);
    expect(parsed).not.toBeNull();
    expect(parsed!.mimeType).toBe("image/png");
    expect(parsed!.byteLength).toBeGreaterThan(0);
  });

  test("validateDataUrlImage rejects unsupported schemes", () => {
    const result = validateDataUrlImage("https://example.com/x.png");
    expect(result.ok).toBe(false);
  });

  test("bytesToDataUrl round-trips PNG bytes", () => {
    const parsed = parseDataUrlImage(TINY_PNG_DATA_URL)!;
    const roundTrip = bytesToDataUrl(parsed.bytes, parsed.mimeType);
    expect(parseDataUrlImage(roundTrip)?.byteLength).toBe(parsed.byteLength);
  });

  test("isWriterImageInline recognizes OBJ placeholder + data URL style", () => {
    expect(
      isWriterImageInline({
        text: WRITER_IMAGE_OBJECT_CHAR,
        style: { image: { src: TINY_PNG_DATA_URL, width: 10, height: 10 } },
      }),
    ).toBe(true);
    expect(isWriterImageInline({ text: "not-image", style: {} })).toBe(false);
  });

  test("OFFICE_RUN_IMAGE_INDEX_PROP is stable", () => {
    expect(OFFICE_RUN_IMAGE_INDEX_PROP).toBe("_imageIndex");
  });
});
