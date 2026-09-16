import { previewKindForPath } from "../lib/file-preview";
import { docxViewerAdapter } from "./ooxml/docx";
import { htmlViewerAdapter } from "./html/index";
import { imageViewerAdapter } from "./image/adapter";
import { markdownViewerAdapter } from "./markdown/adapter";
import { pdfViewerAdapter } from "./pdf/adapter";
import { textViewerAdapter } from "./text/adapter";
import { xlsxViewerAdapter } from "./ooxml/xlsx";
import { pptxViewerAdapter } from "./ooxml/pptx";
import type { ReaderFile } from "../components/work-surface/reader-surface";
import type { ViewerAdapter } from "./types";

const viewerAdapters: readonly ViewerAdapter[] = [
  imageViewerAdapter,
  pdfViewerAdapter,
  docxViewerAdapter,
  xlsxViewerAdapter,
  pptxViewerAdapter,
  markdownViewerAdapter,
  htmlViewerAdapter,
  textViewerAdapter,
];

export function viewerKindForPath(
  path: string,
): "image" | "pdf" | "docx" | "xlsx" | "pptx" | "markdown" | "html" | "text" | "fallback" {
  const fsFile = { kind: "fs" as const, path, rootPath: "" };
  if (imageViewerAdapter.canView(fsFile)) return "image";
  if (pdfViewerAdapter.canView(fsFile)) return "pdf";
  if (docxViewerAdapter.canView(fsFile)) return "docx";
  if (xlsxViewerAdapter.canView(fsFile)) return "xlsx";
  if (pptxViewerAdapter.canView(fsFile)) return "pptx";
  const preview = previewKindForPath(path);
  if (preview.kind === "markdown") return "markdown";
  if (htmlViewerAdapter.canView(fsFile)) return "html";
  if (preview.kind === "text") return "text";
  return "fallback";
}

export function adapterForFile(file: ReaderFile): ViewerAdapter | null {
  return viewerAdapters.find((adapter) => adapter.canView(file)) ?? null;
}
