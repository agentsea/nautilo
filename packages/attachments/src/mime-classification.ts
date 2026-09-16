/**
 * MIME sniffing for multimodal file reads (D069). Used when `file` command
 * reads workspace paths that are images or PDFs — extension-first, then
 * magic-byte fallback (OpenCode-style).
 */

import * as path from "node:path";

const IMAGE_MIMES_FOR_MODEL_INPUT = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function isImageMimeForModelInput(mime: string): boolean {
  const base = mime.trim().split(";")[0]?.trim().toLowerCase() ?? "";
  const fixed = base === "image/jpg" ? "image/jpeg" : base;
  return IMAGE_MIMES_FOR_MODEL_INPUT.has(fixed);
}

export function isPdfMimeForModelInput(mime: string): boolean {
  const base = mime.trim().split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/pdf";
}

/**
 * Look up an extension-to-MIME mapping for `filePath`. Returns `null`
 * when the extension is unknown. Use `mimeFromExtensionOr(...)` when a
 * caller wants a fallback (typically `application/octet-stream`).
 */
export function mimeFromExtension(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * Same as `mimeFromExtension` but returns `fallback` (default
 * `application/octet-stream`) when the extension is unknown. Used by
 * upload paths that need a definite Content-Type for storage.
 */
export function mimeFromExtensionOr(
  filePath: string,
  fallback: string = "application/octet-stream",
): string {
  return mimeFromExtension(filePath) ?? fallback;
}

/**
 * Infer MIME from path extension (cheap) and/or magic bytes in `head`
 * (first bytes of the file). Returns null when unknown.
 */
export function sniffMimeFromPathAndBytes(filePath: string, head: Buffer): string | null {
  const fromExt = mimeFromExtension(filePath);
  if (fromExt && (isImageMimeForModelInput(fromExt) || isPdfMimeForModelInput(fromExt))) {
    return fromExt;
  }

  const fromMagic = sniffMagicBytes(head);
  if (fromMagic) return fromMagic;

  return null;
}

function sniffMagicBytes(head: Buffer): string | null {
  if (head.length < 4) return null;

  // PNG
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF87a / GIF89a
  if (
    head[0] === 0x47 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x38 &&
    (head[4] === 0x37 || head[4] === 0x39)
  ) {
    return "image/gif";
  }

  // PDF
  if (
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46
  ) {
    return "application/pdf";
  }

  // WebP: RIFF....WEBP
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}
