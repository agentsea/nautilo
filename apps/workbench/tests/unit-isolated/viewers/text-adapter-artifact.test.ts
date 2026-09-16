import { beforeEach, describe, expect, mock, test } from "bun:test";

let nextBlob: Blob = new Blob(["alpha"], { type: "text/plain" });
const bytesMock = mock(async () => nextBlob);
mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytes: bytesMock,
  },
}));

const { textViewerAdapter } = await import("../../../src/viewers/text/adapter");

describe("textViewerAdapter artifact branch", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    nextBlob = new Blob(["alpha"], { type: "text/plain" });
  });

  test("load reads text from blob", async () => {
    const r = await textViewerAdapter.load(
      { kind: "artifact", id: "t1", path: "x.txt", mimeType: "text/plain" },
      { maxTextBytes: 10_000 },
    );
    expect(bytesMock).toHaveBeenCalledWith("t1");
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect((r.data as { content: string }).content).toBe("alpha");
    }
  });

  test("over-cap blob → kind: too_large (M088C item 3 step 3)", async () => {
    nextBlob = new Blob(["x".repeat(20_000)], { type: "text/plain" });
    const r = await textViewerAdapter.load(
      { kind: "artifact", id: "t-big", path: "huge.txt", mimeType: "text/plain" },
      { maxTextBytes: 10_000 },
    );
    expect(r.kind).toBe("too_large");
  });
});
