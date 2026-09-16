import * as pdfjs from "pdfjs-dist";

/**
 * A Web-only, manually invoked runtime for the local PDF qualification
 * fixture. The shared renderer it is paired with is checked by the
 * three-platform export-closure probe; this is not a product viewing capability.
 */
export interface SharedBrowserViewerPdfQualificationRuntime {
  configureWorker(): void;
  cleanup(): void;
  readonly runtime: {
    getDocument: typeof pdfjs.getDocument;
  };
}

export function createSharedBrowserViewerPdfQualificationRuntime(): SharedBrowserViewerPdfQualificationRuntime {
  let worker: Worker | undefined;
  return {
    configureWorker(): void {
      if (worker) throw new Error("PDF qualification worker is already configured.");
      worker = new Worker(new URL("pdfjs-dist/build/pdf.worker.mjs", window.location.href));
      pdfjs.GlobalWorkerOptions.workerPort = worker;
    },
    cleanup(): void {
      if (worker && pdfjs.GlobalWorkerOptions.workerPort === worker) {
        pdfjs.GlobalWorkerOptions.workerPort = null;
      }
      worker?.terminate();
      worker = undefined;
    },
    runtime: { getDocument: pdfjs.getDocument },
  };
}
