import * as pdfjs from "pdfjs-dist";

import type { SharedBrowserViewerExportProbe } from "../shared-browser-viewer-export-probe-contract";

/**
 * This is qualification plumbing only. It deliberately never receives bytes
 * or asks PDF.js to parse/render a document.
 */
export function loadPdfExportProbe(): SharedBrowserViewerExportProbe {
  const worker = new Worker(new URL("pdfjs-dist/build/pdf.worker.mjs", window.location.href));
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  let cleaned = false;
  return {
    format: "pdf",
    identity: "nautilo.shared-browser-viewer-export-probe.pdf.v1:pdfjs-dist@6.2.108:WorkerMessageHandler",
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      if (pdfjs.GlobalWorkerOptions.workerPort === worker) {
        pdfjs.GlobalWorkerOptions.workerPort = null;
      }
      worker.terminate();
    },
  };
}
