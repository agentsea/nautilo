import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "../../bun-dom-preload";
import { reapplyHappyDomGlobals } from "../../bun-dom-preload";
import { ooxmlTestMaster, ooxmlTestSource } from "./ooxml-test-source";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

let lastOptions: {
  onSlideChange?: (index: number, total: number) => void;
  onScaleChange?: (scale: number) => void;
  onError?: (error: Error) => void;
  [key: string]: unknown;
} | undefined;
let currentSlide = 0;
let slideCount = 3;
let loadBehavior: () => Promise<void> = async () => {};
let loadedBytes: ArrayBuffer | undefined;
const constructorCalls: Array<{ canvas: HTMLCanvasElement; options: typeof lastOptions }> = [];
const destroyMock = mock(() => {});
const nextSlideMock = mock(async () => {
  currentSlide += 1;
  lastOptions?.onSlideChange?.(currentSlide, slideCount);
});
const prevSlideMock = mock(async () => {
  currentSlide -= 1;
  lastOptions?.onSlideChange?.(currentSlide, slideCount);
});
const zoomInMock = mock(async () => {});
const zoomOutMock = mock(async () => {});
const fitWidthMock = mock(async () => {});
let fitPageBehavior: () => Promise<void> = async () => {};
const fitPageMock = mock(async () => fitPageBehavior());
const findTextMock = mock(async () => []);
const findNextMock = mock(async () => null);
const findPrevMock = mock(async () => null);
const clearFindMock = mock(() => {});
let resizeCallback: ((entries: Array<{ contentRect: { width: number; height: number } }>) => void) | undefined;

class MockPptxViewer {
  constructor(canvas: HTMLCanvasElement, options?: typeof lastOptions) {
    lastOptions = options;
    constructorCalls.push({ canvas, options });
  }

  get slideIndex() {
    return currentSlide;
  }

  get slideCount() {
    return slideCount;
  }

  load(source: ArrayBuffer) {
    loadedBytes = source;
    return loadBehavior();
  }

  nextSlide = nextSlideMock;
  prevSlide = prevSlideMock;
  zoomIn = zoomInMock;
  zoomOut = zoomOutMock;
  fitWidth = fitWidthMock;
  fitPage = fitPageMock;
  getScale = () => 0.75;
  findText = findTextMock;
  findNext = findNextMock;
  findPrev = findPrevMock;
  clearFind = clearFindMock;
  destroy = destroyMock;
}

mock.module("@silurus/ooxml/pptx", () => ({
  PptxPresentation: class PptxPresentation {},
  PptxViewer: MockPptxViewer,
}));

function fixtureBytes(name: string): ArrayBuffer {
  const contents = readFileSync(resolve(import.meta.dir, `../../fixtures/ooxml/pptx/${name}`));
  return contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer;
}

let nextBytes = fixtureBytes("simple.pptx");
const artifactBytesMock = mock(async () => nextBytes);
mock.module("../../../src/lib/api", () => ({
  apiClient: { getWorkspaceArtifactBytesArrayBuffer: artifactBytesMock },
}));

let stat = { exists: true, size: nextBytes.byteLength };
const statMock = mock(async () => stat);
const binaryOpenMock = mock(async () => ({ ok: true as const, data: { id: "session", size: nextBytes.byteLength, chunkSize: nextBytes.byteLength } }));
const binaryReadMock = mock(async (_id: string, position: number) => {
  const chunk = position === 0 ? new Uint8Array(nextBytes) : new Uint8Array();
  return { ok: true as const, data: { bytes: chunk, position: position + chunk.byteLength, done: true } };
});
const binaryCloseMock = mock(async () => ({ ok: true as const, data: null }));
mock.module("../../../src/lib/desktop", () => ({
  desktopAPI: { fs: { stat: statMock }, binaryRead: { open: binaryOpenMock, read: binaryReadMock, close: binaryCloseMock } },
}));

const { OoxmlPptxViewer, pptxViewerAdapter } = await import("../../../src/viewers/ooxml/pptx");

function fsTarget(path = "/work/deck.pptx") {
  return { kind: "fs" as const, path, rootPath: "/work" };
}

const readySource = () => ooxmlTestSource();

describe("unified OOXML PPTX adapter", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    constructorCalls.length = 0;
    destroyMock.mockClear();
    nextSlideMock.mockClear();
    prevSlideMock.mockClear();
    zoomInMock.mockClear();
    zoomOutMock.mockClear();
    fitWidthMock.mockClear();
    fitPageMock.mockClear();
    findTextMock.mockClear();
    findNextMock.mockClear();
    findPrevMock.mockClear();
    clearFindMock.mockClear();
    artifactBytesMock.mockClear();
    statMock.mockClear();
    binaryOpenMock.mockClear();
    binaryReadMock.mockClear();
    binaryCloseMock.mockClear();
    lastOptions = undefined;
    currentSlide = 0;
    slideCount = 3;
    nextBytes = fixtureBytes("simple.pptx");
    stat = { exists: true, size: nextBytes.byteLength };
    loadBehavior = async () => {};
    fitPageBehavior = async () => {};
    loadedBytes = undefined;
    resizeCallback = undefined;
    globalThis.ResizeObserver = class {
      constructor(callback: typeof resizeCallback) { resizeCallback = callback; }
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => cleanup());

  test("detects only exact PPTX sources", () => {
    expect(pptxViewerAdapter.canView(fsTarget())).toBe(true);
    expect(pptxViewerAdapter.canView(fsTarget("/work/deck.pptm"))).toBe(false);
    expect(pptxViewerAdapter.canView(fsTarget("/work/deck.ppt"))).toBe(false);
    expect(pptxViewerAdapter.canView({ kind: "artifact", id: "a", path: "deck.pptx", mimeType: PPTX_MIME })).toBe(true);
    expect(pptxViewerAdapter.canView({ kind: "artifact", id: "a", path: "deck.ppt", mimeType: "application/vnd.ms-powerpoint" })).toBe(false);
  });

  test("loads authorized artifact bytes as a private OOXML source", async () => {
    const result = await pptxViewerAdapter.load(
      { kind: "artifact", id: "artifact-id", path: "deck.pptx", mimeType: PPTX_MIME, roomId: "room-id" },
      { maxTextBytes: 1 },
    );
    expect(artifactBytesMock).toHaveBeenCalledWith("artifact-id", expect.objectContaining({ roomId: "room-id", maxBytes: 100 * 1024 * 1024 }));
    expect(statMock).not.toHaveBeenCalled();
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.data).toMatchObject({ byteLength: nextBytes.byteLength });
    expect("clone" in (result.data as object)).toBe(false);
  });

  test("maps shared oversized and desktop-source results without touching the wrong authority path", async () => {
    const artifactResult = await pptxViewerAdapter.load(
      { kind: "artifact", id: "big", path: "deck.pptx", mimeType: PPTX_MIME, sizeBytes: 101 * 1024 * 1024 },
      { maxTextBytes: 1 },
    );
    expect(artifactResult.kind).toBe("too_large");
    expect(statMock).not.toHaveBeenCalled();

    stat = { exists: true, size: nextBytes.byteLength };
    const fsResult = await pptxViewerAdapter.load(fsTarget(), { maxTextBytes: 1 });
    expect(fsResult.kind).toBe("ready");
    expect(statMock).toHaveBeenCalledWith("/work/deck.pptx");
    expect(binaryOpenMock).toHaveBeenCalledWith("/work/deck.pptx");
  });

  test("fits the reader viewport and presents compact navigation, zoom, and search controls", async () => {
    const master = ooxmlTestMaster();
    const masterFirstByte = new Uint8Array(master)[0];
    const data = ooxmlTestSource(master);
    const view = render(<OoxmlPptxViewer data={data} />);
    await waitFor(() => expect(view.getByText("Slide 1 of 3")).toBeTruthy());
    expect(loadedBytes).not.toBe(master);
    new Uint8Array(loadedBytes!)[0] = 9;
    expect(new Uint8Array(master)[0]).toBe(masterFirstByte);

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.options).toMatchObject({
      mode: "main",
      useGoogleFonts: false,
      resourceLimits: {
        maxArchiveEntryBytes: 64 * 1024 * 1024,
        maxTotalInflatedBytes: 512 * 1024 * 1024,
      },
      workerTimeoutMs: 30_000,
      enableHyperlinks: false,
      enableMediaPlayback: false,
      enableTextSelection: true,
    });
    expect(fitPageMock).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Previous slide" }).hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Next slide" })));
    expect(nextSlideMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(view.getByText("Slide 2 of 3")).toBeTruthy());

    await act(async () => fireEvent.click(view.getByRole("button", { name: "Zoom in" })));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Zoom out" })));
    await act(async () => fireEvent.change(view.getByLabelText("Fit mode"), { target: { value: "width" } }));
    expect(zoomInMock).toHaveBeenCalledTimes(1);
    expect(zoomOutMock).toHaveBeenCalledTimes(1);
    expect(fitWidthMock).toHaveBeenCalledTimes(1);
    expect(view.queryByLabelText("Find in presentation")).toBeNull();
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Search" })));
    const findInput = view.getByLabelText("Find in presentation") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(findInput), "value")?.set?.call(findInput, "sovereign");
    await act(async () => fireEvent.input(findInput));
    findTextMock.mockImplementationOnce(async () => [{ location: { slide: 0 } }, { location: { slide: 1 } }]);
    await waitFor(() => expect((view.getByLabelText("Find in presentation") as HTMLInputElement).value).toBe("sovereign"));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Find" })));
    await waitFor(() => expect(findTextMock).toHaveBeenCalledWith("sovereign"));
    expect(findNextMock).toHaveBeenCalledTimes(1);
    expect(view.getByText("2 matches")).toBeTruthy();
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Previous match" })));
    expect(findPrevMock).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Clear search" })));
    expect(clearFindMock).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Search" })));
    const noMatchInput = view.getByLabelText("Find in presentation") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(noMatchInput), "value")?.set?.call(noMatchInput, "absent");
    await act(async () => fireEvent.input(noMatchInput));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Find" })));
    await waitFor(() => expect(view.getByText("No matches")).toBeTruthy());

    resizeCallback?.([{ contentRect: { width: 640, height: 480 } }]);
    await waitFor(() => expect(fitWidthMock).toHaveBeenCalledTimes(2));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Zoom in" })));
    resizeCallback?.([{ contentRect: { width: 720, height: 480 } }]);
    expect(fitWidthMock).toHaveBeenCalledTimes(2);
    await act(async () => fireEvent.change(view.getByLabelText("Fit mode"), { target: { value: "page" } }));
    resizeCallback?.([{ contentRect: { width: 800, height: 480 } }]);
    await waitFor(() => expect(fitPageMock).toHaveBeenCalledTimes(3));
  });

  test("an onError callback cannot later publish a ready state", async () => {
    loadBehavior = async () => {
      lastOptions?.onError?.(new Error("private parser detail"));
    };
    const view = render(<OoxmlPptxViewer data={readySource()} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Unable to preview this document."));
    expect(view.queryByText("Slide 1 of 3")).toBeNull();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("replaces and unmounts viewers through one destroy path per instance", async () => {
    const first = readySource();
    const second = readySource();
    const view = render(<OoxmlPptxViewer data={first} />);
    await waitFor(() => expect(constructorCalls).toHaveLength(1));
    view.rerender(<OoxmlPptxViewer data={second} />);
    await waitFor(() => expect(constructorCalls).toHaveLength(2));
    expect(destroyMock).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(destroyMock).toHaveBeenCalledTimes(2);
  });

  test("does not publish a replaced viewer after its deferred initial fit resolves", async () => {
    let resolveFirstFit!: () => void;
    fitPageBehavior = () => new Promise<void>((resolve) => { resolveFirstFit = resolve; });
    const first = readySource();
    const second = readySource();
    const view = render(<OoxmlPptxViewer data={first} />);
    await waitFor(() => expect(fitPageMock).toHaveBeenCalledTimes(1));

    fitPageBehavior = async () => {};
    view.rerender(<OoxmlPptxViewer data={second} />);
    await waitFor(() => expect(view.getByText("Slide 1 of 3")).toBeTruthy());
    currentSlide = 2;
    resolveFirstFit();
    await act(async () => { await Promise.resolve(); });

    expect(view.getByText("Slide 1 of 3")).toBeTruthy();
    expect(view.queryByText("Slide 3 of 3")).toBeNull();
  });

  test("keeps controls unavailable through the initial fit barrier and safely fails its rejection", async () => {
    let rejectInitialFit!: (error: Error) => void;
    fitPageBehavior = () => new Promise<void>((_resolve, reject) => { rejectInitialFit = reject; });
    const view = render(<OoxmlPptxViewer data={readySource()} />);
    await waitFor(() => expect(fitPageMock).toHaveBeenCalledTimes(1));

    expect(view.getByText("Loading…")).toBeTruthy();
    expect(view.getByRole("button", { name: "Next slide" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("button", { name: "Search" }).hasAttribute("disabled")).toBe(true);
    rejectInitialFit(new Error("private fit detail"));

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toBe(
        "Presentation preview failed: Unable to preview this document.",
      ),
    );
    expect(view.queryByText("Slide 1 of 3")).toBeNull();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("rejects a forged source through the sanitized destroy-once path", async () => {
    const forged = Object.freeze({
      byteLength: 1,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    });
    const view = render(<OoxmlPptxViewer data={forged} />);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "Unable to preview this document.",
      ),
    );
    expect(loadedBytes).toBeUndefined();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});

afterAll(() => {
  mock.restore();
  reapplyHappyDomGlobals();
});
