import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WorkspaceArtifactLengthMismatchError } from "@nautilo/api-client/browser";

let nextBytes: ArrayBuffer = new TextEncoder().encode("# hi").buffer;
const bytesMock = mock(async () => nextBytes);
const metadataMock = mock(async () => ({ size: nextBytes.byteLength }));
mock.module("../../../src/lib/api", () => ({
  apiClient: {
    getWorkspaceArtifactBytesArrayBuffer: bytesMock,
    getWorkspaceArtifact: metadataMock,
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

  test("recovers an open target whose size preceded a Markdown edit", async () => {
    bytesMock.mockRejectedValueOnce(new WorkspaceArtifactLengthMismatchError("truncated", "Artifact response exceeded its authorized size."));
    const file = { kind: "artifact" as const, id: "m1", roomId: "room-1", path: "n.md", mimeType: "text/markdown", sizeBytes: 1 };
    const signal = new AbortController().signal;
    const result = await markdownViewerAdapter.load(file, { maxTextBytes: 100, signal });
    expect(result).toEqual({ kind: "ready", data: { content: "# hi" } });
    expect(metadataMock).toHaveBeenCalledWith("m1", { roomId: "room-1", signal });
    expect(bytesMock.mock.calls).toEqual([1, nextBytes.byteLength].map(expectedBytes => [
      "m1", { expectedBytes, maxBytes: 100, roomId: "room-1", signal },
    ]));
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
