import { XlsxViewer } from "@silurus/ooxml/xlsx";
import wasmAsset from "@nautilo/shared-browser-viewer-wasm/xlsx_parser_bg.wasm";

import type { SharedBrowserViewerExportProbe } from "../shared-browser-viewer-export-probe-contract";

/** Direct entry and explicit parser URL only; do not mount or parse here. */
export function loadXlsxExportProbe(): SharedBrowserViewerExportProbe {
  return {
    format: "xlsx",
    identity: `nautilo.shared-browser-viewer-export-probe.xlsx.v1:@silurus/ooxml@0.75.2:${typeof XlsxViewer}`,
    assetUrl: String(wasmAsset),
    wasmUrl: String(wasmAsset),
    cleanup(): void {},
  };
}
