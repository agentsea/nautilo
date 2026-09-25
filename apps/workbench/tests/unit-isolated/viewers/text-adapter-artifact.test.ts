import { beforeEach, describe, expect, mock, test } from "bun:test";

let nextBytes: ArrayBuffer = new TextEncoder().encode("alpha").buffer;
const bytesMock = mock(async () => nextBytes);
mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytesArrayBuffer: bytesMock,
  },
}));

const { textViewerAdapter } = await import("../../../src/viewers/text/adapter");

describe("textViewerAdapter artifact branch", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    nextBytes = new TextEncoder().encode("alpha").buffer;
  });

  test("load reads text from bounded artifact bytes", async () => {
    const r = await textViewerAdapter.load(
      { kind: "artifact", id: "t1", path: "x.txt", mimeType: "text/plain" },
      { maxTextBytes: 10_000 },
    );
    expect(bytesMock).toHaveBeenCalledWith("t1", expect.objectContaining({ maxBytes: 10_000 }));
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect((r.data as { content: string }).content).toBe("alpha");
    }
  });

  test("over-cap metadata returns too_large before fetching", async () => {
    const r = await textViewerAdapter.load(
      { kind: "artifact", id: "t-big", path: "huge.txt", mimeType: "text/plain", sizeBytes: 20_000 },
      { maxTextBytes: 10_000 },
    );
    expect(r.kind).toBe("too_large");
    expect(bytesMock).not.toHaveBeenCalled();
  });
});
