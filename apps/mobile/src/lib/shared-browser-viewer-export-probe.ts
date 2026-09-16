import type {
  SharedBrowserViewerExportProbe,
  SharedBrowserViewerProbeFormat,
} from "./shared-browser-viewer-export-probe-contract";

export {
  SHARED_BROWSER_VIEWER_PROBE_FORMATS,
} from "./shared-browser-viewer-export-probe-contract";
export type {
  SharedBrowserViewerExportProbe,
  SharedBrowserViewerProbeFormat,
} from "./shared-browser-viewer-export-probe-contract";

/**
 * A deliberately inert universal boundary. Platform resolution selects the
 * Web implementation; iOS and Android have no browser worker, parser, or
 * WASM import path to reach.
 */

export function loadSharedBrowserViewerExportProbe(
  _format: SharedBrowserViewerProbeFormat,
): Promise<SharedBrowserViewerExportProbe> {
  return Promise.reject(new Error("Shared browser viewer export qualification is available on Web only."));
}
