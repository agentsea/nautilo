import { describe, expect, test } from "bun:test";
import { normalizeEmbeddedRasterDataUrl } from "./raster-data-url";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const JPEG_HEADER = "/9j/4AAQSkZJRg==";

describe("normalizeEmbeddedRasterDataUrl", () => {
  test("normalizes admitted PNG, JPEG, and GIF MIME casing after header checks", () => {
    expect(normalizeEmbeddedRasterDataUrl(`data:image/PNG;base64,${PNG_1X1}`))
      .toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(normalizeEmbeddedRasterDataUrl(`data:image/jpeg;base64,${JPEG_HEADER}`))
      .toBe(`data:image/jpeg;base64,${JPEG_HEADER}`);
    expect(normalizeEmbeddedRasterDataUrl(`data:image/gif;base64,${GIF_1X1}`))
      .toBe(`data:image/gif;base64,${GIF_1X1}`);
  });

  test("rejects mismatched magic, malformed base64, whitespace, and unsupported media", () => {
    expect(normalizeEmbeddedRasterDataUrl(`data:image/jpeg;base64,${PNG_1X1}`)).toBeNull();
    expect(normalizeEmbeddedRasterDataUrl("data:image/png;base64,AAAA=A==")).toBeNull();
    expect(normalizeEmbeddedRasterDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRv==")).toBeNull();
    expect(normalizeEmbeddedRasterDataUrl(`data:image/png;base64,${PNG_1X1}\n`)).toBeNull();
    expect(normalizeEmbeddedRasterDataUrl("data:image/webp;base64,UklGRg==")).toBeNull();
    expect(normalizeEmbeddedRasterDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
  });

  test("rejects recognizable PNG and GIF headers with zero dimensions", () => {
    expect(normalizeEmbeddedRasterDataUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAAAAAAA")).toBeNull();
    expect(normalizeEmbeddedRasterDataUrl("data:image/gif;base64,R0lGODlhAAAAAAAAAA==")).toBeNull();
  });
});
