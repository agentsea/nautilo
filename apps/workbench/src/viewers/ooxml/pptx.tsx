import { useCallback, useEffect, useRef, useState } from "react";
import { PptxViewer, type PptxViewerOptions } from "@silurus/ooxml/pptx";
import { renderOoxml } from "@nautilo/browser-document-viewer/ooxml/renderer";
import { apiClient } from "../../lib/api";
import { loadArtifactViewerArrayBuffer } from "../artifact-byte-source";
import { desktopAPI } from "../../lib/desktop";
import { isPptxPath } from "../file-kind";
import type { ViewerAdapter } from "../types";
import { buildOoxmlViewerOptions, sanitizeOoxmlError } from "./runtime";
import {
  loadOoxmlByteSource,
  type OoxmlByteSource,
} from "./source";
import { OoxmlControlGroup, OoxmlToolbar, OoxmlToolbarButton, OoxmlZoomControls, type FitMode } from "./toolbar";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function formatSlidePosition(index: number, total: number): string {
  return `Slide ${index + 1} of ${total}`;
}

/** The production, read-only Silurus PPTX surface. */
export function OoxmlPptxViewer({ data }: { data: unknown }) {
  const source = data as OoxmlByteSource;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<PptxViewer | null>(null);
  const fitModeRef = useRef<FitMode>("page");
  const resizingRef = useRef(false);
  const findGenerationRef = useRef(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [scale, setScale] = useState<number | null>(null);
  const [fitMode, setFitMode] = useState<FitMode>("page");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCount, setFindCount] = useState<number | null>(null);
  const [findError, setFindError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let active = true;
    let viewer: PptxViewer | null = null;
    let viewerIsLive: (() => boolean) | null = null;
    let viewerFail: ((error: unknown) => void) | null = null;

    const renderer = renderOoxml({
      source,
      host: canvas,
      sanitizeError: sanitizeOoxmlError,
      createViewer: ({ host, fail, isLive }) => {
        const options: PptxViewerOptions = {
          ...(buildOoxmlViewerOptions("pptx") as PptxViewerOptions),
          enableTextSelection: true,
          onSlideChange: (index, total) => {
            if (!isLive()) return;
            setSlideIndex(index);
            setSlideCount(total);
          },
          onScaleChange: (nextScale) => {
            if (isLive()) setScale(nextScale);
          },
          onError: fail,
        };
        const nextViewer = new PptxViewer(host, options);
        viewer = nextViewer;
        viewerIsLive = isLive;
        viewerFail = fail;
        return nextViewer;
      },
      load: async (value, parserBytes) => value.load(parserBytes),
      onStatus: (next) => {
        if (!active) return;
        if (next.kind === "loading") {
          viewerRef.current = null;
          fitModeRef.current = "page";
          findGenerationRef.current += 1;
          setLoading(true);
          setError(null);
          setSlideIndex(0);
          setSlideCount(0);
          setScale(null);
          setFitMode("page");
          setFindOpen(false);
          setFindQuery("");
          setFindCount(null);
          setFindError(false);
        } else if (next.kind === "ready") {
          const readyViewer = next.viewer;
          const isReadyViewerLive = viewerIsLive;
          const failReadyViewer = viewerFail;
          // Silurus's single-slide viewer deliberately starts at intrinsic scale.
          // A Reader should instead use all of its viewport on first paint.
          void (async () => {
            try {
              await readyViewer.fitPage();
              if (!active || viewer !== readyViewer || !isReadyViewerLive?.()) return;
              viewerRef.current = readyViewer;
              setSlideIndex(readyViewer.slideIndex);
              setSlideCount(readyViewer.slideCount);
              setScale(readyViewer.getScale());
              setLoading(false);
            } catch (fitError) {
              failReadyViewer?.(fitError);
            }
          })();
        } else if (next.kind === "error") {
          if (viewerRef.current === viewer) viewerRef.current = null;
          setLoading(false);
          setError(next.message);
        }
      },
    });

    return () => {
      active = false;
      if (viewerRef.current === viewer) viewerRef.current = null;
      findGenerationRef.current += 1;
      renderer.close();
    };
  }, [source]);

  const canUseViewer = !loading && error === null && viewerRef.current !== null;

  const applyFitMode = useCallback((mode: Exclude<FitMode, "manual">) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    fitModeRef.current = mode;
    setFitMode(mode);
    void (async () => {
      try {
        await (mode === "page" ? viewer.fitPage() : viewer.fitWidth());
        if (viewerRef.current !== viewer) return;
        setScale(viewer.getScale());
      } catch {
        // Zoom failures should not replace an otherwise usable preview.
      }
    })();
  }, []);

  const leaveAutoFit = useCallback((action: "in" | "out") => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    fitModeRef.current = "manual";
    setFitMode("manual");
    void (async () => {
      try {
        await (action === "in" ? viewer.zoomIn() : viewer.zoomOut());
        if (viewerRef.current !== viewer) return;
        setScale(viewer.getScale());
      } catch {
        // The viewer owns render errors; keep this control local.
      }
    })();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !canUseViewer || fitMode === "manual" || typeof ResizeObserver === "undefined") return;
    let active = true;
    let lastWidth = host.clientWidth;
    let lastHeight = host.clientHeight;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = Math.round(entry?.contentRect.width ?? host.clientWidth);
      const height = Math.round(entry?.contentRect.height ?? host.clientHeight);
      if (!width || !height || (width === lastWidth && height === lastHeight) || resizingRef.current) return;
      lastWidth = width;
      lastHeight = height;
      const viewer = viewerRef.current;
      const mode = fitModeRef.current;
      if (!viewer || mode === "manual") return;
      resizingRef.current = true;
      void (async () => {
        try {
          await (mode === "page" ? viewer.fitPage() : viewer.fitWidth());
          if (!active || viewerRef.current !== viewer) return;
          setScale(viewer.getScale());
        } catch {
          // A transient resize cannot make the document preview fail.
        } finally {
          resizingRef.current = false;
        }
      })();
    });
    observer.observe(host);
    return () => {
      active = false;
      resizingRef.current = false;
      observer.disconnect();
    };
  }, [canUseViewer, fitMode]);

  const submitFind = useCallback(() => {
    const viewer = viewerRef.current;
    const query = findQuery.trim();
    if (!viewer) return;
    const generation = ++findGenerationRef.current;
    if (!query) {
      viewer.clearFind();
      setFindCount(null);
      setFindError(false);
      return;
    }
    void (async () => {
      try {
        const matches = await viewer.findText(query);
        if (viewerRef.current !== viewer || findGenerationRef.current !== generation) return;
        setFindCount(matches.length);
        setFindError(false);
        if (matches.length > 0) await viewer.findNext();
      } catch {
        if (viewerRef.current !== viewer || findGenerationRef.current !== generation) return;
        setFindCount(null);
        setFindError(true);
      }
    })();
  }, [findQuery]);

  const clearFind = useCallback(() => {
    findGenerationRef.current += 1;
    viewerRef.current?.clearFind();
    setFindQuery("");
    setFindCount(null);
    setFindError(false);
    setFindOpen(false);
  }, []);

  const updateFindQuery = useCallback((value: string) => {
    findGenerationRef.current += 1;
    setFindQuery(value);
    if (!value.trim()) {
      viewerRef.current?.clearFind();
      setFindCount(null);
      setFindError(false);
    }
  }, []);

  const atStart = slideCount === 0 || slideIndex <= 0;
  const atEnd = slideCount === 0 || slideIndex >= slideCount - 1;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-label="Presentation preview">
      <OoxmlToolbar label="Presentation controls">
        <OoxmlControlGroup label="Slide navigation">
          <OoxmlToolbarButton enabled={canUseViewer && !atStart} onClick={() => void viewerRef.current?.prevSlide()} aria-label="Previous slide">‹</OoxmlToolbarButton>
          <span className="min-w-24 text-center text-sm text-foreground-muted" aria-live="polite" aria-atomic="true">
            {loading ? "Loading…" : error ? "Preview failed" : slideCount > 0 ? formatSlidePosition(slideIndex, slideCount) : "No slides"}
          </span>
          <OoxmlToolbarButton enabled={canUseViewer && !atEnd} onClick={() => void viewerRef.current?.nextSlide()} aria-label="Next slide">›</OoxmlToolbarButton>
        </OoxmlControlGroup>
        <OoxmlControlGroup label="Presentation tools">
          <OoxmlZoomControls enabled={canUseViewer} scale={scale} fitMode={fitMode} onZoomOut={() => leaveAutoFit("out")} onZoomIn={() => leaveAutoFit("in")} onFitModeChange={applyFitMode} />
          <OoxmlToolbarButton enabled={canUseViewer} onClick={() => setFindOpen((open) => !open)} aria-expanded={findOpen} aria-controls="pptx-find-panel">Search</OoxmlToolbarButton>
        </OoxmlControlGroup>
      </OoxmlToolbar>
      {findOpen ? (
        <form id="pptx-find-panel" className="flex flex-wrap items-center gap-1" onSubmit={(event) => { event.preventDefault(); submitFind(); }}>
          <label className="sr-only" htmlFor="pptx-find">Find in presentation</label>
          <input id="pptx-find" value={findQuery} onChange={(event) => updateFindQuery(event.target.value)} onInput={(event) => updateFindQuery(event.currentTarget.value)} disabled={!canUseViewer} placeholder="Find in presentation" className="min-w-48 rounded-md border border-border bg-background-panel px-2 py-1 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50" />
          <OoxmlToolbarButton enabled={canUseViewer && Boolean(findQuery.trim())} type="submit">Find</OoxmlToolbarButton>
          {findCount !== null ? <span className="text-xs text-foreground-muted" aria-live="polite">{findCount > 0 ? `${findCount} ${findCount === 1 ? "match" : "matches"}` : "No matches"}</span> : null}
          {findError ? <span className="text-xs text-[var(--error)]" role="status">Search unavailable.</span> : null}
          {findCount !== null && findCount > 0 ? <>
            <OoxmlToolbarButton enabled={canUseViewer} onClick={() => void viewerRef.current?.findPrev()} aria-label="Previous match">‹</OoxmlToolbarButton>
            <OoxmlToolbarButton enabled={canUseViewer} onClick={() => void viewerRef.current?.findNext()} aria-label="Next match">›</OoxmlToolbarButton>
          </> : null}
          <OoxmlToolbarButton enabled={canUseViewer} onClick={clearFind} aria-label="Clear search">×</OoxmlToolbarButton>
        </form>
      ) : null}
      <div ref={hostRef} className="min-h-[240px] min-w-0 flex-1 overflow-auto rounded-md border border-border bg-background-panel" aria-busy={loading}>
        <canvas ref={canvasRef} className="block" />
      </div>
      {error ? <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]" role="alert">Presentation preview failed: {error}</div> : null}
    </section>
  );
}

export const pptxViewerAdapter: ViewerAdapter = {
  kind: "pptx",
  canView(file) {
    return file.kind === "fs" ? isPptxPath(file.path) : file.mimeType === PPTX_MIME;
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
  Component: OoxmlPptxViewer,
};
