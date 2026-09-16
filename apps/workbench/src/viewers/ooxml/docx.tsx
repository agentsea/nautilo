import { useEffect, useRef, useState } from "react";
import { DocxScrollViewer, type DocxScrollViewerOptions } from "@silurus/ooxml/docx";
import { renderOoxml } from "@nautilo/browser-document-viewer/ooxml/renderer";
import { apiClient } from "../../lib/api";
import { loadArtifactViewerArrayBuffer } from "../artifact-byte-source";
import { desktopAPI } from "../../lib/desktop";
import { isDocxPath } from "../file-kind";
import type { ViewerAdapter } from "../types";
import { buildOoxmlViewerOptions, sanitizeOoxmlError } from "./runtime";
import {
  loadOoxmlByteSource,
  type OoxmlByteSource,
} from "./source";
import { OoxmlControlGroup, OoxmlToolbar, OoxmlToolbarButton, OoxmlZoomControls, type FitMode } from "./toolbar";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type DocxViewerState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function DocxViewer({ data }: { data: unknown }) {
  const source = data as OoxmlByteSource;
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DocxViewerState>({ kind: "loading" });
  const [viewer, setViewer] = useState<DocxScrollViewer | null>(null);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState<number | null>(null);
  const [fitMode, setFitMode] = useState<FitMode>("width");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let active = true;
    setState({ kind: "loading" });
    setViewer(null);
    setPage(0);
    setPageCount(0);
    setScale(null);
    setFitMode("width");

    const renderer = renderOoxml({
      source,
      host,
      sanitizeError: sanitizeOoxmlError,
      createViewer: ({ host: viewerHost, fail, isLive }) => {
        const options: DocxScrollViewerOptions = {
          ...(buildOoxmlViewerOptions("docx") as DocxScrollViewerOptions),
          enableTextSelection: true,
          onError: fail,
          onVisiblePageChange: (nextPage, total) => {
            if (!isLive()) return;
            setPage(nextPage);
            setPageCount(total);
          },
          onScaleChange: (nextScale) => {
            if (isLive()) setScale(nextScale);
          },
        };
        return new DocxScrollViewer(viewerHost, options);
      },
      load: async (value, parserBytes) => value.load(parserBytes),
      onStatus: (next) => {
        if (!active) return;
        if (next.kind === "loading") {
          setState({ kind: "loading" });
        } else if (next.kind === "ready") {
          setPage(Math.max(0, next.viewer.topVisiblePage));
          setPageCount(next.viewer.pageCount);
          setScale(next.viewer.getScale());
          setViewer(next.viewer);
          setState({ kind: "ready" });
        } else if (next.kind === "error") {
          setViewer(null);
          setState({ kind: "error", message: next.message });
        }
      },
    });

    return () => {
      active = false;
      renderer.close();
      host.replaceChildren();
    };
  }, [source]);

  const ready = state.kind === "ready" && viewer !== null;
  const currentPage = Math.min(Math.max(page, 0), Math.max(pageCount - 1, 0));
  const selectFitMode = (mode: Exclude<FitMode, "manual">) => {
    if (!viewer) return;
    setFitMode(mode);
    void (mode === "page" ? viewer.fitPage() : viewer.fitWidth());
  };

  const zoom = (direction: "in" | "out") => {
    if (!viewer) return;
    setFitMode("manual");
    if (direction === "in") viewer.zoomIn();
    else viewer.zoomOut();
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-label="DOCX preview">
      <OoxmlToolbar label="Document controls">
        <OoxmlControlGroup label="Page navigation">
          <OoxmlToolbarButton enabled={ready && currentPage > 0} onClick={() => viewer?.scrollToPage(currentPage - 1)} aria-label="Previous page">‹</OoxmlToolbarButton>
          <span className="min-w-24 text-center text-sm text-foreground-muted" aria-live="polite">{pageCount > 0 ? `Page ${currentPage + 1} of ${pageCount}` : "Pages loading"}</span>
          <OoxmlToolbarButton enabled={ready && currentPage + 1 < pageCount} onClick={() => viewer?.scrollToPage(currentPage + 1)} aria-label="Next page">›</OoxmlToolbarButton>
        </OoxmlControlGroup>
        <OoxmlControlGroup label="Document tools">
          <OoxmlZoomControls enabled={ready} scale={scale} fitMode={fitMode} onZoomOut={() => zoom("out")} onZoomIn={() => zoom("in")} onFitModeChange={selectFitMode} />
          <span className="text-xs text-foreground-muted">Find is unavailable for DOCX scroll previews.</span>
        </OoxmlControlGroup>
      </OoxmlToolbar>
      {state.kind === "loading" && <p className="text-sm text-foreground-muted" aria-live="polite">Loading document preview…</p>}
      {state.kind === "error" && <p className="text-sm text-[var(--error)]" role="alert">{state.message}</p>}
      <div ref={hostRef} className="min-h-[20rem] flex-1 overflow-hidden rounded border border-border bg-background-panel" aria-busy={state.kind === "loading"} />
    </section>
  );
}

export const docxViewerAdapter: ViewerAdapter = {
  kind: "docx",
  canView(file) {
    return file.kind === "fs" ? isDocxPath(file.path) : file.mimeType === DOCX_MIME;
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
  Component: DocxViewer,
};
