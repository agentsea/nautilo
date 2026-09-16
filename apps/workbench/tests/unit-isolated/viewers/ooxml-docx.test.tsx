import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "../../bun-dom-preload";
import { reapplyHappyDomGlobals } from "../../bun-dom-preload";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let loadReject: unknown = null;
let loadResolveAfterError = false;
let latestOptions: {
  onError?: (error: Error) => void;
  onVisiblePageChange?: (page: number, total: number) => void;
  onScaleChange?: (scale: number) => void;
} | undefined;
const destroyMock = mock(() => {});
let loadedBytes: ArrayBuffer | undefined;
const loadMock = mock(async (source: ArrayBuffer) => {
  loadedBytes = source;
  if (loadReject) throw loadReject;
  if (loadResolveAfterError) latestOptions?.onError?.(new Error("private parse details"));
});
const scrollToPageMock = mock(() => {});
const zoomInMock = mock(() => {});
const zoomOutMock = mock(() => {});
const fitWidthMock = mock(() => {});
const fitPageMock = mock(() => {});

mock.module("@silurus/ooxml/docx", () => ({
  DocxDocument: { load: mock(async () => {}) },
  DocxScrollViewer: class {
    pageCount = 3;
    topVisiblePage = 0;
    constructor(_host: HTMLElement, options: typeof latestOptions) {
      latestOptions = options;
    }
    load = loadMock;
    destroy = destroyMock;
    scrollToPage = scrollToPageMock;
    zoomIn = zoomInMock;
    zoomOut = zoomOutMock;
    fitWidth = fitWidthMock;
    fitPage = fitPageMock;
    getScale = () => 1;
  },
}));

function fixtureBytes(name: string): ArrayBuffer {
  const contents = readFileSync(resolve(import.meta.dir, `../../fixtures/ooxml/docx/${name}`));
  return contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer;
}

let bytes = fixtureBytes("simple.docx");
const getWorkspaceArtifactBytesArrayBuffer = mock(async () => bytes);
mock.module("../../../src/lib/api", () => ({ apiClient: { getWorkspaceArtifactBytesArrayBuffer } }));

let statResult = { exists: true, size: bytes.byteLength };
const statMock = mock(async () => statResult);
const binaryOpenMock = mock(async () => ({ ok: true as const, data: { id: "session", size: bytes.byteLength, chunkSize: bytes.byteLength } }));
const binaryReadMock = mock(async (_id: string, position: number) => {
  const chunk = position === 0 ? new Uint8Array(bytes) : new Uint8Array();
  return { ok: true as const, data: { bytes: chunk, position: position + chunk.byteLength, done: true } };
});
const binaryCloseMock = mock(async () => ({ ok: true as const, data: null }));
mock.module("../../../src/lib/desktop", () => ({
  desktopAPI: { fs: { stat: statMock }, binaryRead: { open: binaryOpenMock, read: binaryReadMock, close: binaryCloseMock } },
}));

const { docxViewerAdapter } = await import("../../../src/viewers/ooxml/docx");

function fsFile(path = "/work/document.docx") {
  return { kind: "fs" as const, path, rootPath: "/work" };
}

describe("Silurus DOCX OOXML adapter", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    bytes = fixtureBytes("simple.docx");
    statResult = { exists: true, size: bytes.byteLength };
    loadReject = null;
    loadResolveAfterError = false;
    latestOptions = undefined;
    loadedBytes = undefined;
    for (const fn of [destroyMock, loadMock, scrollToPageMock, zoomInMock, zoomOutMock, fitWidthMock, fitPageMock, getWorkspaceArtifactBytesArrayBuffer, statMock, binaryOpenMock, binaryReadMock, binaryCloseMock]) fn.mockClear();
  });

  afterEach(cleanup);

  test("uses exact DOCX detection", () => {
    expect(docxViewerAdapter.canView(fsFile("/work/REPORT.DOCX"))).toBeTrue();
    expect(docxViewerAdapter.canView(fsFile("/work/report.docm"))).toBeFalse();
    expect(docxViewerAdapter.canView({ kind: "artifact", id: "docx", path: "private.bin", mimeType: DOCX_MIME })).toBeTrue();
    expect(docxViewerAdapter.canView({ kind: "artifact", id: "doc", path: "private.docx", mimeType: "application/msword" })).toBeFalse();
  });

  test("loads raw private byte sources through the shared artifact contract", async () => {
    const result = await docxViewerAdapter.load({ kind: "artifact", id: "artifact", path: "private.docx", mimeType: DOCX_MIME, roomId: "room" }, { maxTextBytes: 1 });
    expect(getWorkspaceArtifactBytesArrayBuffer).toHaveBeenCalledWith("artifact", expect.objectContaining({ roomId: "room", maxBytes: 100 * 1024 * 1024 }));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.data).toMatchObject({ byteLength: bytes.byteLength });
    expect("clone" in (result.data as object)).toBe(false);
  });

  test("passes unchanged shared too-large and error results", async () => {
    const tooLarge = await docxViewerAdapter.load({ kind: "artifact", id: "large", path: "large.docx", mimeType: DOCX_MIME, sizeBytes: 101 * 1024 * 1024 }, { maxTextBytes: 1 });
    expect(tooLarge).toMatchObject({ kind: "too_large", maxBytes: 100 * 1024 * 1024 });
    statResult = { exists: false, size: 0 };
    expect(await docxViewerAdapter.load(fsFile(), { maxTextBytes: 1 })).toEqual({ kind: "error", message: "File no longer exists." });
  });

  test("mounts the virtual scroll viewer with safe selection and inert links", async () => {
    const loaded = await docxViewerAdapter.load(fsFile(), { maxTextBytes: 1 });
    expect(loaded.kind).toBe("ready");
    if (loaded.kind !== "ready") return;
    const view = render(<docxViewerAdapter.Component file={fsFile()} data={loaded.data} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
    expect(loadedBytes).not.toBe(bytes);
    new Uint8Array(loadedBytes!)[0] = 9;
    expect(new Uint8Array(bytes)[0]).toBe(0x50);
    expect(latestOptions).toMatchObject({
      enableTextSelection: true,
      enableHyperlinks: false,
      useGoogleFonts: false,
      workerTimeoutMs: 30_000,
      resourceLimits: {
        maxArchiveEntryBytes: 64 * 1024 * 1024,
        maxTotalInflatedBytes: 512 * 1024 * 1024,
      },
    });
    await waitFor(() => expect(view.getByText("Page 1 of 3")).toBeTruthy());
    act(() => {
      latestOptions?.onVisiblePageChange?.(1, 3);
      latestOptions?.onScaleChange?.(1.25);
    });
    expect(view.getByText("Page 2 of 3")).toBeTruthy();
    expect(view.getByText("125%")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Next page" }));
    fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
    fireEvent.change(view.getByLabelText("Fit mode"), { target: { value: "page" } });
    expect(scrollToPageMock).toHaveBeenCalledWith(2);
    expect(zoomInMock).toHaveBeenCalled();
    expect(fitPageMock).toHaveBeenCalled();
    expect(view.getByText("Find is unavailable for DOCX scroll previews.")).toBeTruthy();
  });

  test("destroys the viewer on replacement and unmount", async () => {
    const first = await docxViewerAdapter.load(fsFile(), { maxTextBytes: 1 });
    const second = await docxViewerAdapter.load(fsFile(), { maxTextBytes: 1 });
    if (first.kind !== "ready" || second.kind !== "ready") throw new Error("fixture load failed");
    const view = render(<docxViewerAdapter.Component file={fsFile()} data={first.data} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
    view.rerender(<docxViewerAdapter.Component file={fsFile()} data={second.data} />);
    await waitFor(() => expect(destroyMock).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(destroyMock).toHaveBeenCalledTimes(2);
  });

  test("a viewer onError cannot later become ready", async () => {
    loadResolveAfterError = true;
    const loaded = await docxViewerAdapter.load(fsFile(), { maxTextBytes: 1 });
    if (loaded.kind !== "ready") throw new Error("fixture load failed");
    const view = render(<docxViewerAdapter.Component file={fsFile()} data={loaded.data} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Unable to preview this document."));
    expect(view.queryByText("Page 1 of 3")).toBeNull();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a forged source through the sanitized destroy-once path", async () => {
    const forged = Object.freeze({
      byteLength: 1,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    });
    const view = render(<docxViewerAdapter.Component file={fsFile()} data={forged} />);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        "Unable to preview this document.",
      ),
    );
    expect(loadMock).not.toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
