import { DocxScrollViewer } from "@silurus/ooxml/docx";
import wasmAsset from "@nautilo/shared-browser-viewer-wasm/docx_parser_bg.wasm";

import type { SharedBrowserViewerExportProbe } from "../shared-browser-viewer-export-probe-contract";

/** Direct entry and explicit parser URL only; do not mount or parse here. */
export function loadDocxExportProbe(): SharedBrowserViewerExportProbe {
  return {
    format: "docx",
    identity: `nautilo.shared-browser-viewer-export-probe.docx.v1:@silurus/ooxml@0.75.2:${typeof DocxScrollViewer}`,
    assetUrl: String(wasmAsset),
    wasmUrl: String(wasmAsset),
    cleanup(): void {},
  };
}
