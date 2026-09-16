import { basename } from "../lib/file-preview";

function extensionOfPath(path: string): string | null {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot).toLowerCase();
}

export function isPdfPath(path: string): boolean {
  return extensionOfPath(path) === ".pdf";
}

export function imageMimeForPath(path: string): string | null {
  switch (extensionOfPath(path)) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

export function isImagePath(path: string): boolean {
  return imageMimeForPath(path) !== null;
}

export function isDocxPath(path: string): boolean {
  return extensionOfPath(path) === ".docx";
}

/**
 * D362 — office documents the Collabora-backed viewer/editor can open
 * (Writer/Calc/Impress + their legacy and OpenDocument variants). Used to
 * offer "Open in Office" on an artifact.
 */
const OFFICE_DOC_EXTS = new Set([
  ".docx",
  ".doc",
  ".odt",
  ".rtf",
  ".xlsx",
  ".xls",
  ".ods",
  ".csv",
  ".pptx",
  ".ppt",
  ".odp",
]);

export function isOfficeDocPath(path: string): boolean {
  const ext = extensionOfPath(path);
  return ext !== null && OFFICE_DOC_EXTS.has(ext);
}

export function isXlsxPath(path: string): boolean {
  return extensionOfPath(path) === ".xlsx";
}

export function isPptxPath(path: string): boolean {
  return extensionOfPath(path) === ".pptx";
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isPdfMime(mime: string): boolean {
  return mime === "application/pdf";
}

