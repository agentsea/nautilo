import { useCallback, useEffect, useRef, useState } from "react";
import { XlsxViewer, type XlsxViewerOptions } from "@silurus/ooxml/xlsx";
import { renderOoxml } from "@nautilo/browser-document-viewer/ooxml/renderer";
import { apiClient } from "../../lib/api";
import { loadArtifactViewerArrayBuffer } from "../artifact-byte-source";
import { desktopAPI } from "../../lib/desktop";
import { isXlsxPath } from "../file-kind";
import type { ViewerAdapter, ViewerProps } from "../types";
import { buildOoxmlViewerOptions, sanitizeOoxmlError } from "./runtime";
import {
  loadOoxmlByteSource,
  type OoxmlByteSource,
} from "./source";
import { OoxmlControlGroup, OoxmlToolbar, OoxmlToolbarButton, OoxmlZoomControls, type FitMode } from "./toolbar";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type ViewerState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function sheetPosition(index: number, names: string[]): string {
  const total = names.length;
  if (total === 0) return "No sheets";
  return `Sheet ${index + 1} of ${total}: ${names[index] ?? "Untitled sheet"}`;
}

/**
 * The production XLSX reader keeps the authorized OOXML bytes private and
 * gives the Silurus parser one disposable clone per mounted viewer.
 */
export function OoxmlXlsxViewer({ data }: ViewerProps) {
  const source = data as OoxmlByteSource;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<XlsxViewer | null>(null);
  const [state, setState] = useState<ViewerState>({ kind: "loading" });
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [findQuery, setFindQuery] = useState("");
  const [findCount, setFindCount] = useState<number | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [scale, setScale] = useState<number | null>(null);
  const [fitMode, setFitMode] = useState<FitMode>("width");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let viewer: XlsxViewer | null = null;

    const renderer = renderOoxml({
      source,
      host: container,
      sanitizeError: sanitizeOoxmlError,
      createViewer: ({ host, fail, isLive }) => {
        const options = {
          ...buildOoxmlViewerOptions("xlsx"),
          // The host toolbar presents these controls while the viewer retains its
          // native, keyboard-accessible grid selection and Ctrl/Cmd+C behaviour.
          showZoomSlider: false,
          onReady: (names: string[]) => {
            if (isLive()) setSheetNames(names);
          },
          onSheetChange: (index: number) => {
            if (isLive()) setSheetIndex(index);
          },
          onScaleChange: (nextScale: number) => {
            if (isLive()) setScale(nextScale);
          },
          onError: fail,
        } as XlsxViewerOptions;
        const nextViewer = new XlsxViewer(host, options);
        viewer = nextViewer;
        viewerRef.current = nextViewer;
        return nextViewer;
      },
      load: async (activeViewer, parserBytes) => activeViewer.load(parserBytes),
      onStatus: (next) => {
        if (!active) return;
        if (next.kind === "loading") {
          setState({ kind: "loading" });
          setSheetNames([]);
          setSheetIndex(0);
          setFindCount(null);
          setFindOpen(false);
          setScale(null);
          setFitMode("width");
        } else if (next.kind === "ready") {
          if (viewerRef.current !== next.viewer) return;
          setSheetNames(next.viewer.sheetNames);
          setSheetIndex(next.viewer.sheetIndex);
          setScale(next.viewer.getScale());
          setState({ kind: "ready" });
        } else if (next.kind === "error") {
          if (viewerRef.current === viewer) viewerRef.current = null;
          setState({ kind: "error", message: next.message });
        }
      },
    });

    return () => {
      active = false;
      renderer.close();
      if (viewerRef.current === viewer) viewerRef.current = null;
    };
  }, [source]);

  const withViewer = useCallback((action: (viewer: XlsxViewer) => void | Promise<void>) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    void action(viewer);
  }, []);

  const find = useCallback(() => {
    withViewer(async (viewer) => {
      const query = findQuery.trim();
      if (!query) {
        viewer.clearFind();
        setFindCount(null);
        return;
      }
      try {
        const matches = await viewer.findText(query);
        setFindCount(matches.length);
        if (matches.length > 0) await viewer.findNext();
      } catch {
        // Keep search failure bounded to its control rather than exposing parser
        // details or changing ownership of an otherwise usable workbook.
        setFindCount(0);
      }
    });
  }, [findQuery, withViewer]);

  const isReady = state.kind === "ready";
  const atStart = sheetIndex <= 0;
  const atEnd = sheetNames.length === 0 || sheetIndex >= sheetNames.length - 1;
  const selectFitMode = (mode: Exclude<FitMode, "manual">) => {
    setFitMode(mode);
    withViewer((viewer) => mode === "page" ? viewer.fitPage() : viewer.fitWidth());
  };
  const zoom = (direction: "in" | "out") => {
    setFitMode("manual");
    withViewer((viewer) => direction === "in" ? viewer.zoomIn() : viewer.zoomOut());
  };
  const clearFind = () => {
    withViewer((viewer) => viewer.clearFind());
    setFindQuery("");
    setFindCount(null);
    setFindOpen(false);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label="Spreadsheet preview">
      <OoxmlToolbar label="Spreadsheet controls">
        <OoxmlControlGroup label="Sheet navigation">
          <OoxmlToolbarButton enabled={isReady && !atStart} onClick={() => withViewer((viewer) => viewer.prevSheet())} aria-label="Previous sheet">‹</OoxmlToolbarButton>
          <span className="min-w-32 text-center text-sm text-foreground-muted" aria-live="polite" aria-atomic="true">{state.kind === "loading" ? "Loading…" : sheetPosition(sheetIndex, sheetNames)}</span>
          <OoxmlToolbarButton enabled={isReady && !atEnd} onClick={() => withViewer((viewer) => viewer.nextSheet())} aria-label="Next sheet">›</OoxmlToolbarButton>
        </OoxmlControlGroup>
        <OoxmlControlGroup label="Spreadsheet tools">
          <OoxmlZoomControls enabled={isReady} scale={scale} fitMode={fitMode} onZoomOut={() => zoom("out")} onZoomIn={() => zoom("in")} onFitModeChange={selectFitMode} pageLabel="Fit sheet" />
          <OoxmlToolbarButton enabled={isReady} onClick={() => setFindOpen((open) => !open)} aria-expanded={findOpen} aria-controls="ooxml-xlsx-find-panel">Search</OoxmlToolbarButton>
        </OoxmlControlGroup>
      </OoxmlToolbar>
      {findOpen ? <form id="ooxml-xlsx-find-panel" className="flex flex-wrap items-center gap-1" onSubmit={(event) => { event.preventDefault(); find(); }}>
        <label className="sr-only" htmlFor="ooxml-xlsx-find">Find in workbook</label>
        <input id="ooxml-xlsx-find" value={findQuery} onChange={(event) => setFindQuery(event.target.value)} disabled={!isReady} placeholder="Find in workbook" className="min-w-48 rounded-md border border-border bg-background-panel px-2 py-1 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50" />
        <OoxmlToolbarButton enabled={isReady} type="submit">Find</OoxmlToolbarButton>
        {findCount && findCount > 0 ? <>
          <OoxmlToolbarButton enabled={isReady} onClick={() => withViewer(async (viewer) => { await viewer.findPrev(); })} aria-label="Previous match">‹</OoxmlToolbarButton>
          <OoxmlToolbarButton enabled={isReady} onClick={() => withViewer(async (viewer) => { await viewer.findNext(); })} aria-label="Next match">›</OoxmlToolbarButton>
        </> : null}
        {findCount !== null && <span className="text-xs text-foreground-muted" aria-live="polite">{findCount} {findCount === 1 ? "match" : "matches"}</span>}
        <OoxmlToolbarButton enabled={isReady} onClick={clearFind} aria-label="Clear search">×</OoxmlToolbarButton>
      </form> : null}
      {state.kind === "error" && <div role="alert" className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">Spreadsheet preview failed: {state.message}</div>}
      <p className="text-xs text-foreground-muted">Select cells in the grid and press Ctrl/Cmd+C to copy.</p>
      <div ref={containerRef} className="min-h-[240px] w-full flex-1 overflow-hidden rounded-md border border-border bg-background-panel" aria-busy={state.kind === "loading"} />
    </section>
  );
}

export const xlsxViewerAdapter: ViewerAdapter = {
  kind: "xlsx",
  canView(file) {
    return file.kind === "fs" ? isXlsxPath(file.path) : file.mimeType === XLSX_MIME;
  },
  async load(file, ctx) {
    const result = await loadOoxmlByteSource(file, {
      getWorkspaceArtifactBytesArrayBuffer: (id, options) =>
        file.kind === "artifact" && ctx.artifactBytes !== undefined
          ? loadArtifactViewerArrayBuffer(file, ctx, options?.maxBytes ?? Number.MAX_SAFE_INTEGER)
          : apiClient.getWorkspaceArtifactBytesArrayBuffer(id, options),
      desktopAPI,
    }, ctx);
    return result.kind === "ready" ? { kind: "ready", data: result.source } : result;
  },
  Component: OoxmlXlsxViewer,
};

export const _test = { sheetPosition, XLSX_MIME };
