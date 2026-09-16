import { describe, expect, test } from "bun:test";
import {
  isImageMimeForModelInput,
  isPdfMimeForModelInput,
  mimeFromExtension,
  mimeFromExtensionOr,
  sniffMimeFromPathAndBytes,
} from "../../src/mime-classification";

describe("mime-classification", () => {
  test("isImageMimeForModelInput accepts canonical types", () => {
    expect(isImageMimeForModelInput("image/png")).toBe(true);
    expect(isImageMimeForModelInput("image/jpeg")).toBe(true);
    expect(isImageMimeForModelInput("image/jpg")).toBe(true);
    expect(isImageMimeForModelInput("application/pdf")).toBe(false);
  });

  test("isPdfMimeForModelInput", () => {
    expect(isPdfMimeForModelInput("application/pdf")).toBe(true);
    expect(isPdfMimeForModelInput("image/png")).toBe(false);
  });

  test("sniffMimeFromPathAndBytes uses extension when magic absent", () => {
    const empty = Buffer.alloc(0);
    expect(sniffMimeFromPathAndBytes("/tmp/x.png", empty)).toBe("image/png");
    expect(sniffMimeFromPathAndBytes("/tmp/x.PDF", empty)).toBe("application/pdf");
  });

  test("sniffMimeFromPathAndBytes prefers magic bytes over wrong extension", () => {
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffMimeFromPathAndBytes("/tmp/wrong.txt", pngHead)).toBe("image/png");
  });

  test("sniffMimeFromPathAndBytes detects JPEG magic", () => {
    const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffMimeFromPathAndBytes("/tmp/x", jpegHead)).toBe("image/jpeg");
  });

  test("sniffMimeFromPathAndBytes detects PDF magic", () => {
    const pdfHead = Buffer.from("%PDF-1.4\n", "utf8");
    expect(sniffMimeFromPathAndBytes("/tmp/doc", pdfHead)).toBe("application/pdf");
  });

  test("sniffMimeFromPathAndBytes detects WebP magic", () => {
    const buf = Buffer.alloc(12);
    buf.write("RIFF", 0);
    buf.write("WEBP", 8);
    expect(sniffMimeFromPathAndBytes("/tmp/x.webp", buf)).toBe("image/webp");
  });

  test("sniffMimeFromPathAndBytes returns null for unknown binary", () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(sniffMimeFromPathAndBytes("/tmp/a.bin", bin)).toBe(null);
  });

  test("mimeFromExtension covers images, documents, and code; null for unknown", () => {
    expect(mimeFromExtension("/tmp/a.png")).toBe("image/png");
    expect(mimeFromExtension("/tmp/A.JPG")).toBe("image/jpeg");
    expect(mimeFromExtension("/tmp/a.pdf")).toBe("application/pdf");
    expect(mimeFromExtension("/tmp/a.md")).toBe("text/markdown");
    expect(mimeFromExtension("/tmp/a.json")).toBe("application/json");
    expect(mimeFromExtension("/tmp/a.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mimeFromExtension("/tmp/a.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mimeFromExtension("/tmp/no-ext")).toBe(null);
    expect(mimeFromExtension("/tmp/a.unknown-ext")).toBe(null);
  });

  test("mimeFromExtensionOr falls back to application/octet-stream by default", () => {
    expect(mimeFromExtensionOr("/tmp/a.png")).toBe("image/png");
    expect(mimeFromExtensionOr("/tmp/no-ext")).toBe("application/octet-stream");
    expect(mimeFromExtensionOr("/tmp/no-ext", "text/plain")).toBe("text/plain");
  });
});
