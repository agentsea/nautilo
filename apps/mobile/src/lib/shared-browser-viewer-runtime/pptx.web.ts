import { PptxScrollViewer } from "@silurus/ooxml/pptx";
import wasmAsset from "@nautilo/shared-browser-viewer-wasm/pptx_parser_bg.wasm";

import type { SharedBrowserViewerExportProbe } from "../shared-browser-viewer-export-probe-contract";

/** Direct entry and explicit parser URL only; do not mount or parse here. */
export function loadPptxExportProbe(): SharedBrowserViewerExportProbe {
  return {
    format: "pptx",
    identity: `nautilo.shared-browser-viewer-export-probe.pptx.v1:@silurus/ooxml@0.75.2:${typeof PptxScrollViewer}`,
    assetUrl: String(wasmAsset),
    wasmUrl: String(wasmAsset),
    cleanup(): void {},
  };
}
