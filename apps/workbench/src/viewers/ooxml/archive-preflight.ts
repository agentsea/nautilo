/**
 * Workbench compatibility export. The implementation lives in the inert shared
 * browser document-viewer package so a future browser host can share the same
 * zero-copy rejection behavior without importing Workbench UI/runtime code.
 */
export {
  preflightOoxmlArchive,
  type OoxmlArchivePreflightLimits,
  type OoxmlArchivePreflightReason,
  type OoxmlArchivePreflightResult,
} from "@nautilo/browser-document-viewer";
