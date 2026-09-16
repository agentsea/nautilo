import { beforeEach, describe, expect, mock, test } from "bun:test";

let nextBlob: Blob = new Blob(["# hi"], { type: "text/markdown" });
const bytesMock = mock(async () => nextBlob);
mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytes: bytesMock,
  },
}));

const { markdownViewerAdapter } = await import("../../../src/viewers/markdown/adapter");

describe("markdownViewerAdapter artifact branch", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    nextBlob = new Blob(["# hi"], { type: "text/markdown" });
  });

  test("load reads markdown text from blob", async () => {
    const r = await markdownViewerAdapter.load(
      { kind: "artifact", id: "m1", path: "n.md", mimeType: "text/markdown" },
      { maxTextBytes: 10_000 },
    );
    expect(bytesMock).toHaveBeenCalledWith("m1");
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect((r.data as { content: string }).content).toBe("# hi");
    }
  });

  test("over-cap blob → kind: too_large (M088C item 3 step 3)", async () => {
    nextBlob = new Blob(["x".repeat(20_000)], { type: "text/markdown" });
    const r = await markdownViewerAdapter.load(
      { kind: "artifact", id: "m-big", path: "huge.md", mimeType: "text/markdown" },
      { maxTextBytes: 10_000 },
    );
    expect(r.kind).toBe("too_large");
  });
});
