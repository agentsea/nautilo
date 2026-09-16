import { beforeEach, describe, expect, mock, test } from "bun:test";

const bytesMock = mock(async () => new Uint8Array([1, 2, 3]).buffer);
mock.module("../../src/lib/api", () => ({
  apiClient: { getWorkspaceArtifactBytesArrayBuffer: bytesMock },
}));

const { loadArtifactWorkspaceImageUrl, _resetWorkspaceImageCache } = await import(
  "../../src/components/tool-card/renderers/use-workspace-image"
);

describe("loadArtifactWorkspaceImageUrl", () => {
  beforeEach(() => {
    bytesMock.mockClear();
    _resetWorkspaceImageCache();
  });

  test("uses bounded Artifact ArrayBuffer ingress and returns a Blob URL", async () => {
    const url = await loadArtifactWorkspaceImageUrl("a");
    expect(url.startsWith("blob:")).toBe(true);
    expect(bytesMock).toHaveBeenCalledWith("a", expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }));
  });

  test("passes roomId exactly and caches the object URL until cleanup", async () => {
    const first = await loadArtifactWorkspaceImageUrl("a", { roomId: "room-x" });
    const second = await loadArtifactWorkspaceImageUrl("a", { roomId: "room-x" });
    expect(first).toBe(second);
    expect(bytesMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ roomId: "room-x" }));
  });

  test("honors caller cancellation before starting Artifact ingress", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadArtifactWorkspaceImageUrl("cancelled", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(bytesMock).not.toHaveBeenCalled();
  });
});
