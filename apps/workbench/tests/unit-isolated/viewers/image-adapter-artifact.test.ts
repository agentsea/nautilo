import { beforeEach, describe, expect, mock, test } from "bun:test";

let nextBytes: ArrayBuffer = new Uint8Array([1, 2, 3]).buffer;
const bytesMock = mock(async () => nextBytes);
mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytesArrayBuffer: bytesMock,
  },
}));

const { imageViewerAdapter } = await import("../../../src/viewers/image/adapter");

describe("imageViewerAdapter artifact branch", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    nextBytes = new Uint8Array([1, 2, 3]).buffer;
  });

  test("load fetches bytes for artifact row id", async () => {
    const r = await imageViewerAdapter.load(
      { kind: "artifact", id: "a1", path: "x.png", mimeType: "image/png" },
      { maxTextBytes: 1_000_000 },
    );
    expect(bytesMock).toHaveBeenCalledWith("a1", expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }));
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      const d = r.data as { blob: Blob; alt: string };
      expect(d.blob.type).toBe("image/png");
      expect(d.alt).toBe("x.png");
    }
  });

  test("over-cap metadata → kind: too_large (M088C item 3 step 3)", async () => {
    const r = await imageViewerAdapter.load(
      { kind: "artifact", id: "a-big", path: "huge.png", mimeType: "image/png", sizeBytes: 26 * 1024 * 1024 },
      { maxTextBytes: 1_000_000 },
    );
    expect(r.kind).toBe("too_large");
    if (r.kind === "too_large") {
      expect(r.sizeBytes).toBeGreaterThan(r.maxBytes);
    }
  });

  test("forwards roomId to the api-client", async () => {
    await imageViewerAdapter.load(
      {
        kind: "artifact",
        id: "a-room",
        path: "x.png",
        mimeType: "image/png",
        roomId: "room-7",
      },
      { maxTextBytes: 1_000_000 },
    );
    expect(bytesMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ roomId: "room-7" }));
  });
});
