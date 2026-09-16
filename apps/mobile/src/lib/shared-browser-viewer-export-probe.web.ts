import type {
  SharedBrowserViewerExportProbe,
  SharedBrowserViewerProbeFormat,
} from "./shared-browser-viewer-export-probe-contract";

export { SHARED_BROWSER_VIEWER_PROBE_FORMATS } from "./shared-browser-viewer-export-probe-contract";
export type { SharedBrowserViewerExportProbe, SharedBrowserViewerProbeFormat } from "./shared-browser-viewer-export-probe-contract";

/** Four literal async boundaries: production Expo Web exports split these closures. */
export async function loadSharedBrowserViewerExportProbe(
  format: SharedBrowserViewerProbeFormat,
): Promise<SharedBrowserViewerExportProbe> {
  switch (format) {
    case "pdf":
      return (await import("./shared-browser-viewer-runtime/pdf.web")).loadPdfExportProbe();
    case "docx":
      return (await import("./shared-browser-viewer-runtime/docx.web")).loadDocxExportProbe();
    case "xlsx":
      return (await import("./shared-browser-viewer-runtime/xlsx.web")).loadXlsxExportProbe();
    case "pptx":
      return (await import("./shared-browser-viewer-runtime/pptx.web")).loadPptxExportProbe();
  }
}
