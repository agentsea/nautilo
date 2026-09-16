import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { previewKindForPath } from "../lib/file-preview";
import { htmlViewerAdapter } from "../viewers/html/index";
import {
  isDocxPath,
  isImageMime,
  isImagePath,
  isPdfMime,
  isPdfPath,
  isXlsxPath,
} from "../viewers/file-kind";

export type EditorKind = "markdown" | "code";

const CODE_ARTIFACT_MIMES = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
  "application/xhtml+xml",
  "text/html",
]);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isMarkdownMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return m === "text/markdown" || m.includes("markdown");
}

function isDocxArtifact(file: Extract<OpenFileTarget, { kind: "artifact" }>): boolean {
  return (
    isDocxPath(file.path) ||
    file.mimeType.toLowerCase() === DOCX_MIME
  );
}

function isXlsxArtifact(file: Extract<OpenFileTarget, { kind: "artifact" }>): boolean {
  return (
    isXlsxPath(file.path) ||
    file.mimeType.toLowerCase() === XLSX_MIME
  );
}

function editorKindForArtifact(
  file: Extract<OpenFileTarget, { kind: "artifact" }>,
): EditorKind | null {
  const mime = file.mimeType;

  if (isImageMime(mime) || isPdfMime(mime)) return null;
  if (isDocxArtifact(file) || isXlsxArtifact(file)) return null;

  if (isMarkdownMime(mime) || isMarkdownPath(file.path)) return "markdown";

  const lowerMime = mime.toLowerCase();
  if (lowerMime.startsWith("text/")) return "code";
  if (CODE_ARTIFACT_MIMES.has(lowerMime)) return "code";

  const preview = previewKindForPath(file.path);
  if (preview.kind === "markdown") return "markdown";
  if (preview.kind === "text") return "code";
  if (htmlViewerAdapter.canView(file)) return "code";

  return null;
}

function editorKindForFs(
  file: Extract<OpenFileTarget, { kind: "fs" }>,
): EditorKind | null {
  if (
    isImagePath(file.path) ||
    isPdfPath(file.path) ||
    isDocxPath(file.path) ||
    isXlsxPath(file.path)
  ) {
    return null;
  }

  const preview = previewKindForPath(file.path);
  if (preview.kind === "markdown") return "markdown";
  if (preview.kind === "text") return "code";
  if (htmlViewerAdapter.canView(file)) return "code";

  return null;
}

export function editorKindForFile(file: OpenFileTarget): EditorKind | null {
  if (file.kind === "artifact") return editorKindForArtifact(file);
  return editorKindForFs(file);
}

export function canEditInThisChannel(
  file: OpenFileTarget,
  isDesktopRuntime: boolean,
): boolean {
  if (editorKindForFile(file) === null) return false;
  if (file.kind === "fs" && !isDesktopRuntime) return false;
  return true;
}
