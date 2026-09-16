import { useEffect, useRef, useState } from "react";
import { renderBrowserPdf, type BrowserPdfRendererStatus, type BrowserPdfRuntime } from "@nautilo/browser-document-viewer";
import { desktopAPI } from "../../lib/desktop";
import { apiClient } from "../../lib/api";
import { loadArtifactViewerArrayBuffer } from "../artifact-byte-source";
import { loadBinaryPreview } from "../../lib/binary-preview-source";
import { isPdfMime, isPdfPath } from "../file-kind";
import type { ViewerAdapter } from "../types";

const MAX_PDF_VIEWER_BYTES = 25 * 1024 * 1024;

type PdfJsModule = typeof import("pdfjs-dist");
type PdfViewerData = { bytes: ArrayBuffer; renderDeadlineAt: number };

function PdfViewer({ data }: { data: unknown }) {
  const typed = data as PdfViewerData;
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<BrowserPdfRendererStatus>({ kind: "loading" });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const controller = new AbortController();
    let renderer: ReturnType<typeof renderBrowserPdf> | undefined;
    setStatus({ kind: "loading" });
    void (async () => {
      try {
        const pdfjs: PdfJsModule = await import("pdfjs-dist");
        if (controller.signal.aborted) return;
        renderer = renderBrowserPdf({
          bytes: typed.bytes,
          host: element,
          runtime: pdfjs as unknown as BrowserPdfRuntime,
          configureWorker: () => {
            (pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc =
              new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
          },
          signal: controller.signal,
          deadlineAt: typed.renderDeadlineAt,
          scale: 1.25,
          devicePixelRatio: window.devicePixelRatio || 1,
          onStatus: setStatus,
          onCanvas: (canvas) => {
            canvas.className = "max-w-full rounded bg-white shadow-sm";
          },
        });
      } catch {
        if (!controller.signal.aborted) setStatus({ kind: "error", message: "Document preview failed." });
      }
    })();
    return () => {
      controller.abort();
      renderer?.close();
    };
  }, [typed.bytes, typed.renderDeadlineAt]);

  return (
    <div>
      {status.kind === "error" ? (
        <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
          PDF preview failed.
        </div>
      ) : status.kind !== "ready" ? (
        <div className="text-sm text-foreground-muted">Loading PDF...</div>
      ) : null}
      <div ref={host} className={status.kind === "ready" ? "flex flex-col items-center gap-4" : "hidden"} />
    </div>
  );
}

export const pdfViewerAdapter: ViewerAdapter = {
  kind: "pdf",
  canView(file) {
    return file.kind === "fs" ? isPdfPath(file.path) : isPdfMime(file.mimeType);
  },
  async load(file, ctx) {
    const deadlineAt = ctx.deadlineAt ?? Date.now() + 35_000;
    const result = await loadBinaryPreview(
      file,
      {
        getWorkspaceArtifactBytesArrayBuffer: (id, options) =>
          file.kind === "artifact" && ctx.artifactBytes !== undefined
            ? loadArtifactViewerArrayBuffer(file, ctx, options?.maxBytes ?? MAX_PDF_VIEWER_BYTES)
            : apiClient.getWorkspaceArtifactBytesArrayBuffer(id, options),
        desktopAPI,
      },
      {
        maxBytes: MAX_PDF_VIEWER_BYTES,
        signal: ctx.signal ?? new AbortController().signal,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
        deadlineAt,
      },
    );
    return result.kind === "ready"
      ? { kind: "ready", data: { bytes: result.bytes, renderDeadlineAt: deadlineAt } }
      : result;
  },
  Component: PdfViewer,
};
