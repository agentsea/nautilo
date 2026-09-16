import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "../../bun-dom-preload";
import { reapplyHappyDomGlobals } from "../../bun-dom-preload";
import { ooxmlTestMaster, ooxmlTestSource } from "./ooxml-test-source";

let loadFailure: Error | null = null;
let lastOptions: {
  onReady?: (names: string[]) => void;
  onSheetChange?: (index: number, total: number) => void;
  onError?: (error: Error) => void;
  enableHyperlinks?: boolean;
  showZoomSlider?: boolean;
  useGoogleFonts?: boolean;
} | undefined;
let loadedBytes: ArrayBuffer | undefined;
const destroyMock = mock(() => {});
const previousMock = mock(async () => {});
const nextMock = mock(async () => {});
const zoomOutMock = mock(() => {});
const zoomInMock = mock(() => {});
const fitWidthMock = mock(() => {});
const fitPageMock = mock(() => {});
const getScaleMock = mock(() => 1);
const findTextMock = mock(async () => [{ location: { sheet: 0 } }]);
const findPrevMock = mock(async () => null);
const findNextMock = mock(async () => null);
const clearFindMock = mock(() => {});

class FakeXlsxViewer {
  sheetNames = ["Summary", "Detail"];
  sheetIndex = 0;
  constructor(_container: HTMLElement, options: typeof lastOptions) {
    lastOptions = options;
  }
  async load(bytes: ArrayBuffer) {
    loadedBytes = bytes;
    if (loadFailure) {
      lastOptions?.onError?.(loadFailure);
      return;
    }
    lastOptions?.onReady?.(this.sheetNames);
    lastOptions?.onSheetChange?.(this.sheetIndex, this.sheetNames.length);
  }
  get sheetCount() { return this.sheetNames.length; }
  prevSheet = previousMock;
  nextSheet = nextMock;
  zoomOut = zoomOutMock;
  zoomIn = zoomInMock;
  fitWidth = fitWidthMock;
  fitPage = fitPageMock;
  getScale = getScaleMock;
  findText = findTextMock;
  findPrev = findPrevMock;
  findNext = findNextMock;
  clearFind = clearFindMock;
  destroy = destroyMock;
}

mock.module("@silurus/ooxml/xlsx", () => ({
  XlsxViewer: FakeXlsxViewer,
  XlsxWorkbook: class {},
}));

function fixtureBytes(name: string): ArrayBuffer {
  const contents = readFileSync(
    resolve(import.meta.dir, `../../fixtures/ooxml/xlsx/${name}`),
  );
  return contents.buffer.slice(
    contents.byteOffset,
    contents.byteOffset + contents.byteLength,
  ) as ArrayBuffer;
}

let artifactBytes = fixtureBytes("simple.xlsx");
const artifactBytesMock = mock(async () => artifactBytes);
mock.module("../../../src/lib/api", () => ({ apiClient: { getWorkspaceArtifactBytesArrayBuffer: artifactBytesMock } }));

const statMock = mock(async () => ({ exists: true, size: artifactBytes.byteLength }));
mock.module("../../../src/lib/desktop", () => ({
  desktopAPI: { fs: { stat: statMock } },
}));

const { OoxmlXlsxViewer, _test, xlsxViewerAdapter } = await import("../../../src/viewers/ooxml/xlsx");

const source = () => ooxmlTestSource();

function fsTarget(path: string) {
  return { kind: "fs" as const, path, rootPath: "/work" };
}

describe("D431 unified OOXML XLSX adapter", () => {
  beforeEach(() => {
    reapplyHappyDomGlobals();
    artifactBytes = fixtureBytes("simple.xlsx");
    loadFailure = null;
    lastOptions = undefined;
    loadedBytes = undefined;
    for (const fn of [destroyMock, previousMock, nextMock, zoomOutMock, zoomInMock, fitWidthMock, fitPageMock, getScaleMock, findTextMock, findPrevMock, findNextMock, clearFindMock, artifactBytesMock, statMock]) fn.mockClear();
  });

  afterEach(() => cleanup());

  test("preserves exact XLSX detection", () => {
    expect(xlsxViewerAdapter.canView(fsTarget("/work/report.xlsx"))).toBe(true);
    expect(xlsxViewerAdapter.canView(fsTarget("/work/report.xlsm"))).toBe(false);
    expect(xlsxViewerAdapter.canView({ kind: "artifact", id: "a", path: "report.xlsx", mimeType: _test.XLSX_MIME })).toBe(true);
  });

  test("loads raw private OOXML source via the shared bridge", async () => {
    const result = await xlsxViewerAdapter.load({ kind: "artifact", id: "a", path: "report.xlsx", mimeType: _test.XLSX_MIME }, { maxTextBytes: 1 });
    expect(result.kind).toBe("ready");
    expect(artifactBytesMock).toHaveBeenCalledWith("a", expect.objectContaining({ maxBytes: 100 * 1024 * 1024 }));
    if (result.kind !== "ready") return;
    expect(result.data).toMatchObject({ byteLength: artifactBytes.byteLength });
    expect("clone" in (result.data as object)).toBe(false);
  });

  test("mounts the native viewer with one parser clone, inert hyperlinks, and host controls", async () => {
    const master = ooxmlTestMaster();
    const masterFirstByte = new Uint8Array(master)[0];
    const data = ooxmlTestSource(master);
    const view = render(<OoxmlXlsxViewer file={fsTarget("/work/report.xlsx")} data={data} />);
    await waitFor(() => expect(view.getByText("Sheet 1 of 2: Summary")).toBeTruthy());
    expect(loadedBytes).not.toBeUndefined();
    expect(loadedBytes).not.toBe(master);
    new Uint8Array(loadedBytes!)[0] = 9;
    expect(new Uint8Array(master)[0]).toBe(masterFirstByte);
    expect(lastOptions).toMatchObject({
      enableHyperlinks: false,
      useGoogleFonts: false,
      showZoomSlider: false,
      resourceLimits: {
        maxArchiveEntryBytes: 64 * 1024 * 1024,
        maxTotalInflatedBytes: 512 * 1024 * 1024,
      },
    });

    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Next sheet" })); });
    expect(nextMock).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Zoom out" })); fireEvent.click(view.getByRole("button", { name: "Zoom in" })); fireEvent.change(view.getByLabelText("Fit mode"), { target: { value: "width" } }); fireEvent.change(view.getByLabelText("Fit mode"), { target: { value: "page" } }); });
    expect(zoomOutMock).toHaveBeenCalledTimes(1);
    expect(zoomInMock).toHaveBeenCalledTimes(1);
    expect(fitWidthMock).toHaveBeenCalledTimes(1);
    expect(fitPageMock).toHaveBeenCalledTimes(1);

    expect(view.queryByLabelText("Find in workbook")).toBeNull();
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Search" })); });
    expect(view.getByLabelText("Find in workbook")).toBeTruthy();
    await act(async () => { fireEvent.click(view.getByText("Find")); });
    expect(clearFindMock).toHaveBeenCalledTimes(1);
  });

  test("viewer onError stays failed even when its load promise resolves", async () => {
    loadFailure = new Error("invalid archive");
    const view = render(<OoxmlXlsxViewer file={fsTarget("/work/report.xlsx")} data={source()} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Unable to preview this document."));
    expect(view.queryByText("Sheet 1 of 2: Summary")).toBeNull();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  test("replacement and unmount destroy each viewer exactly once", async () => {
    const first = source();
    const second = source();
    const view = render(
      <OoxmlXlsxViewer file={fsTarget("/work/report.xlsx")} data={first} />,
    );
    await waitFor(() => expect(view.getByText("Sheet 1 of 2: Summary")).toBeTruthy());
    view.rerender(
      <OoxmlXlsxViewer file={fsTarget("/work/report.xlsx")} data={second} />,
    );
    await waitFor(() => expect(destroyMock).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(destroyMock).toHaveBeenCalledTimes(2);
  });

  test("rejects a forged source through the sanitized destroy-once path", async () => {
    const forged = Object.freeze({
      byteLength: 1,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
    });
    const view = render(<OoxmlXlsxViewer file={fsTarget("/work/report.xlsx")} data={forged} />);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "Unable to preview this document.",
      ),
    );
    expect(loadedBytes).toBeUndefined();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
