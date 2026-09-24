import { beforeEach, describe, expect, mock, test } from "bun:test";

let nextBytes: ArrayBuffer = new TextEncoder().encode("# hi").buffer;
const bytesMock = mock(async () => nextBytes);
mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytesArrayBuffer: bytesMock,
  },
}));

const { markdownViewerAdapter } = await import("../../../src/viewers/markdown/adapter");

describe("markdownViewerAdapter artifact branch", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    nextBytes = new TextEncoder().encode("# hi").buffer;
  });

  test("load reads markdown text from bounded artifact bytes", async () => {
    const r = await markdownViewerAdapter.load(
      { kind: "artifact", id: "m1", path: "n.md", mimeType: "text/markdown" },
      { maxTextBytes: 10_000 },
    );
    expect(bytesMock).toHaveBeenCalledWith("m1", expect.objectContaining({ maxBytes: 10_000 }));
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect((r.data as { content: string }).content).toBe("# hi");
    }
  });

  test("over-cap metadata returns too_large before fetching", async () => {
    const r = await markdownViewerAdapter.load(
      { kind: "artifact", id: "m-big", path: "huge.md", mimeType: "text/markdown", sizeBytes: 20_000 },
      { maxTextBytes: 10_000 },
    );
    expect(r.kind).toBe("too_large");
    expect(bytesMock).not.toHaveBeenCalled();
  });
});
