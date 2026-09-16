import { beforeEach, describe, expect, mock, test } from "bun:test";

/** Tiny PDF (one page) — enough for byte-level assertions in unit tests. */
function minimalPdfBytes(): Uint8Array {
  const src =
    "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n" +
    "trailer<</Size 4/Root 1 0 R>>\n" +
    "startxref\n190\n" +
    "%%EOF\n";
  return new TextEncoder().encode(src);
}

let nextBytes: ArrayBuffer = new Uint8Array([4, 5]).buffer;
const bytesMock = mock(async () => nextBytes);
mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytesArrayBuffer: bytesMock,
  },
}));

const { pdfViewerAdapter } = await import("../../../src/viewers/pdf/adapter");

const ctx = { maxTextBytes: 1_000_000 };

describe("pdfViewerAdapter artifact branch", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    nextBytes = minimalPdfBytes().buffer.slice(0);
  });

  test("canView is true for artifact + application/pdf mime", () => {
    const ok = pdfViewerAdapter.canView({
      kind: "artifact",
      id: "row-1",
      path: "artifacts/x.pdf",
      mimeType: "application/pdf",
    });
    expect(ok).toBe(true);
  });

  test("load returns ready with bytes from bounded PDF transport", async () => {
    const r = await pdfViewerAdapter.load(
      {
        kind: "artifact",
        id: "p1",
        path: "artifacts/x.pdf",
        mimeType: "application/pdf",
      },
      ctx,
    );
    expect(bytesMock).toHaveBeenCalledWith("p1", expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }));
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      const d = r.data as { bytes: ArrayBuffer };
      const bytes = new Uint8Array(d.bytes);
      expect(bytes.byteLength).toBeGreaterThan(8);
      expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe("%PDF");
    }
  });

  test("load with roomId passes roomId to bytes API", async () => {
    await pdfViewerAdapter.load(
      {
        kind: "artifact",
        id: "p2",
        path: "y.pdf",
        mimeType: "application/pdf",
        roomId: "room-a",
      },
      ctx,
    );
    expect(bytesMock).toHaveBeenCalledWith("p2", expect.objectContaining({ roomId: "room-a" }));
  });

  test("over-cap metadata → kind: too_large (.pdf) (M088C item 3 step 3)", async () => {
    const r = await pdfViewerAdapter.load(
      { kind: "artifact", id: "p-big", path: "huge.pdf", mimeType: "application/pdf", sizeBytes: 60 * 1024 * 1024 },
      ctx,
    );
    expect(r.kind).toBe("too_large");
    if (r.kind === "too_large") {
      expect(r.sizeBytes).toBeGreaterThan(r.maxBytes);
    }
  });
});
