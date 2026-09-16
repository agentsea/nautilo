import { describe, expect, mock, test } from "bun:test";
import { createCurrentFolderBinaryChunkSource, loadBinaryPreview } from "../../src/lib/binary-preview-source";

describe("binary preview sources", () => {
  test("accepts Electron's post-chunk positions and assembles the complete file", async () => {
    const close = mock(async () => ({ ok: true as const, data: null }));
    const read = mock(async (_id: string, position: number) => {
      const bytes = position === 0 ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5]);
      return {
        ok: true as const,
        data: {
          bytes,
          position: position + bytes.byteLength,
          done: position + bytes.byteLength === 5,
        },
      };
    });
    const result = await loadBinaryPreview(
      { kind: "fs", path: "/work/slides.pptx", rootPath: "/work" },
      {
        getWorkspaceArtifactBytesArrayBuffer: mock(async () => new ArrayBuffer(0)),
        desktopAPI: {
          fs: { stat: mock(async () => ({ exists: true, size: 5 })) },
          binaryRead: {
            open: mock(async () => ({
              ok: true as const,
              data: { id: "live-contract", size: 5, chunkSize: 3 },
            })),
            read,
            close,
          },
        },
      },
      {
        maxBytes: 10,
        signal: new AbortController().signal,
      },
    );

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect([...new Uint8Array(result.bytes)]).toEqual([1, 2, 3, 4, 5]);
    expect(read.mock.calls.map((call) => call[1])).toEqual([0, 3]);
    expect(close).toHaveBeenCalledWith("live-contract");
  });

  test("closes a local session when its post-open metadata conflicts", async () => {
    const close = mock(async () => ({ ok: true as const, data: null }));
    const source = createCurrentFolderBinaryChunkSource("/work/a.png", 3, {
      binaryRead: {
        open: mock(async () => ({ ok: true as const, data: { id: "s", size: 4, chunkSize: 3 } })),
        read: mock(async () => ({ ok: true as const, data: { bytes: new Uint8Array(), position: 0, done: true } })),
        close,
      },
    });
    await expect(async () => {
      for await (const _chunk of source.chunks!(new AbortController().signal)) { /* unreachable */ }
    }).toThrow();
    expect(close).toHaveBeenCalledWith("s");
  });

  test("closes a late-open local session after cancellation", async () => {
    let finishOpen!: () => void;
    const close = mock(async () => ({ ok: true as const, data: null }));
    const source = createCurrentFolderBinaryChunkSource("/work/a.png", 3, {
      binaryRead: {
        open: mock(async () => await new Promise<{ ok: true; data: { id: string; size: number; chunkSize: number } }>((resolve) => { finishOpen = () => resolve({ ok: true, data: { id: "late", size: 3, chunkSize: 3 } }); })),
        read: mock(async () => ({ ok: true as const, data: { bytes: new Uint8Array(), position: 0, done: true } })),
        close,
      },
    });
    const controller = new AbortController();
    const next = source.chunks!(controller.signal)[Symbol.asyncIterator]().next();
    controller.abort();
    finishOpen();
    await expect(next).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledWith("late");
  });

  test("bounds concurrent artifact ingress by FIFO queueing", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<ArrayBuffer>((resolve) => { releaseFirst = () => resolve(new Uint8Array([1]).buffer); });
    const getBytes = mock(async (id: string) => id === "a" ? await first : new Uint8Array([2]).buffer);
    const signal = new AbortController().signal;
    const deps = { getWorkspaceArtifactBytesArrayBuffer: getBytes, desktopAPI: null };
    const a = loadBinaryPreview({ kind: "artifact", id: "a", path: "a", mimeType: "x" }, deps, { maxBytes: 10, signal });
    const b = loadBinaryPreview({ kind: "artifact", id: "b", path: "b", mimeType: "x" }, deps, { maxBytes: 10, signal });
    const c = loadBinaryPreview({ kind: "artifact", id: "c", path: "c", mimeType: "x" }, deps, { maxBytes: 10, signal });
    await Promise.resolve();
    expect(getBytes.mock.calls.map((call) => call[0])).toEqual(["a"]);
    releaseFirst();
    await Promise.all([a, b, c]);
    expect(getBytes.mock.calls.map((call) => call[0])).toEqual(["a", "b", "c"]);
  });

  test("times out while queued and releases the slot for later work", async () => {
    let release!: () => void;
    const held = new Promise<ArrayBuffer>((resolve) => { release = () => resolve(new Uint8Array([1]).buffer); });
    const getBytes = mock(async (id: string) => id === "held" ? await held : new Uint8Array([2]).buffer);
    const signal = new AbortController().signal;
    const deps = { getWorkspaceArtifactBytesArrayBuffer: getBytes, desktopAPI: null };
    const first = loadBinaryPreview({ kind: "artifact", id: "held", path: "held", mimeType: "x" }, deps, { maxBytes: 10, signal });
    const timedOut = await loadBinaryPreview({ kind: "artifact", id: "timeout", path: "timeout", mimeType: "x" }, deps, { maxBytes: 10, signal, timeoutMs: 1 });
    expect(timedOut).toEqual({ kind: "error", message: "Preview loading timed out." });
    release();
    await first;
    await loadBinaryPreview({ kind: "artifact", id: "after", path: "after", mimeType: "x" }, deps, { maxBytes: 10, signal });
    expect(getBytes.mock.calls.map((call) => call[0])).toEqual(["held", "after"]);
  });

  test("times out or cancels a slow stat without opening a late binary session", async () => {
    let resolveTimeoutStat!: (value: { exists: boolean; size: number }) => void;
    let resolveCancelledStat!: (value: { exists: boolean; size: number }) => void;
    const open = mock(async () => ({ ok: true as const, data: { id: "unexpected", size: 1, chunkSize: 1 } }));
    const bridge = {
      fs: { stat: mock(async (path: string) => await new Promise<{ exists: boolean; size: number }>((resolve) => { if (path.endsWith("timeout")) resolveTimeoutStat = resolve; else resolveCancelledStat = resolve; })) },
      binaryRead: {
        open,
        read: mock(async () => ({ ok: true as const, data: { bytes: new Uint8Array([1]), position: 0, done: true } })),
        close: mock(async () => ({ ok: true as const, data: null })),
      },
    };
    const timedOut = await loadBinaryPreview(
      { kind: "fs", path: "/work/timeout", rootPath: "/work" },
      { getWorkspaceArtifactBytesArrayBuffer: mock(async () => new ArrayBuffer(0)), desktopAPI: bridge },
      { maxBytes: 10, signal: new AbortController().signal, timeoutMs: 1 },
    );
    expect(timedOut).toEqual({ kind: "error", message: "Preview loading timed out." });
    resolveTimeoutStat({ exists: true, size: 1 });

    const controller = new AbortController();
    const cancelledPromise = loadBinaryPreview(
      { kind: "fs", path: "/work/cancel", rootPath: "/work" },
      { getWorkspaceArtifactBytesArrayBuffer: mock(async () => new ArrayBuffer(0)), desktopAPI: bridge },
      { maxBytes: 10, signal: controller.signal, timeoutMs: 100 },
    );
    controller.abort();
    expect(await cancelledPromise).toEqual({ kind: "error", message: "Preview loading was cancelled." });
    resolveCancelledStat({ exists: true, size: 1 });
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();

    const noDeadlineController = new AbortController();
    const noDeadline = loadBinaryPreview(
      { kind: "fs", path: "/work/cancel", rootPath: "/work" },
      { getWorkspaceArtifactBytesArrayBuffer: mock(async () => new ArrayBuffer(0)), desktopAPI: bridge },
      { maxBytes: 10, signal: noDeadlineController.signal },
    );
    noDeadlineController.abort();
    expect(await noDeadline).toEqual({ kind: "error", message: "Preview loading was cancelled." });
  });
});
