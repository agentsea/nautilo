// Pure data-URL image helpers for Writer DOCX import/export (no Node built-ins).

/** Wafflebase image placeholder character (OBJECT REPLACEMENT CHARACTER). */
export const WRITER_IMAGE_OBJECT_CHAR = "\uFFFC";

export const SUPPORTED_WRITER_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
] as const;

export type SupportedWriterImageMimeType = (typeof SUPPORTED_WRITER_IMAGE_MIME_TYPES)[number];

/** Per-image byte cap (aligned with OfficeCLI image staging). */
export const MAX_WRITER_DOCX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Total embedded image bytes allowed for one export/import pass. */
export const MAX_WRITER_DOCX_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;

/** 1×1 PNG used by mapper/host tests. */
export const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const DATA_URL_RE =
  /^data:(image\/(?:png|jpeg|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;

export interface ParsedDataUrlImage {
  readonly mimeType: SupportedWriterImageMimeType;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
}

export interface OfficeRunDataUrlImageInput {
  readonly dataUrl: string;
}

export function normalizeWriterImageMimeType(raw: string): SupportedWriterImageMimeType | null {
  const lower = raw.trim().toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (SUPPORTED_WRITER_IMAGE_MIME_TYPES.includes(lower as SupportedWriterImageMimeType)) {
    return lower as SupportedWriterImageMimeType;
  }
  return null;
}

export function parseDataUrlImage(dataUrl: string): ParsedDataUrlImage | null {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) return null;
  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (match === null) return null;
  const mimeType = normalizeWriterImageMimeType(match[1]!);
  if (mimeType === null) return null;
  const payload = match[2]!.replace(/\s+/g, "");
  if (payload.length === 0) return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { mimeType, bytes, byteLength: bytes.byteLength };
  } catch {
    return null;
  }
}

export function validateDataUrlImage(
  dataUrl: string,
  limits: { maxBytes?: number; totalBytes?: number; nextTotal?: number } = {},
): { ok: true; parsed: ParsedDataUrlImage } | { ok: false; reason: string } {
  const parsed = parseDataUrlImage(dataUrl);
  if (parsed === null) {
    return {
      ok: false,
      reason: "image src must be a supported data URL (data:image/png|jpeg|gif|svg+xml;base64,...)",
    };
  }
  const maxBytes = limits.maxBytes ?? MAX_WRITER_DOCX_IMAGE_BYTES;
  if (parsed.byteLength > maxBytes) {
    return {
      ok: false,
      reason: `image is ${parsed.byteLength} bytes; max is ${maxBytes} bytes`,
    };
  }
  const totalCap = limits.totalBytes ?? MAX_WRITER_DOCX_IMAGE_TOTAL_BYTES;
  const nextTotal = (limits.nextTotal ?? 0) + parsed.byteLength;
  if (nextTotal > totalCap) {
    return {
      ok: false,
      reason: `total embedded image bytes would be ${nextTotal}; max is ${totalCap} bytes`,
    };
  }
  return { ok: true, parsed };
}

export function bytesToDataUrl(bytes: Uint8Array, mimeType: SupportedWriterImageMimeType): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export function isWriterImageInline(inline: {
  text?: string;
  style?: Record<string, unknown>;
}): boolean {
  if (inline.text !== WRITER_IMAGE_OBJECT_CHAR) return false;
  const style = inline.style;
  if (style === null || typeof style !== "object" || Array.isArray(style)) return false;
  const image = style["image"];
  if (image === null || typeof image !== "object" || Array.isArray(image)) return false;
  const src = (image as Record<string, unknown>)["src"];
  return typeof src === "string" && src.startsWith("data:");
}

export function readImageInlineStyle(style: Record<string, unknown>): {
  src: string;
  width?: number;
  height?: number;
  alt?: string;
} | null {
  const image = style["image"];
  if (image === null || typeof image !== "object" || Array.isArray(image)) return null;
  const record = image as Record<string, unknown>;
  const src = typeof record["src"] === "string" ? record["src"] : null;
  if (src === null || src.length === 0) return null;
  const width = typeof record["width"] === "number" && Number.isFinite(record["width"])
    ? record["width"]
    : undefined;
  const height = typeof record["height"] === "number" && Number.isFinite(record["height"])
    ? record["height"]
    : undefined;
  const alt = typeof record["alt"] === "string" && record["alt"].length > 0 ? record["alt"] : undefined;
  return { src, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(alt !== undefined ? { alt } : {}) };
}

/** Convert CSS pixels (96dpi) to OfficeCLI cm strings. */
export function pxToCmString(px: number): string {
  const cm = (px * 2.54) / 96;
  const rounded = Math.round(cm * 1000) / 1000;
  return `${rounded}cm`;
}

/** Parse OfficeCLI cm strings (e.g. `2.0cm`) to CSS pixels (96dpi). */
export function cmStringToPx(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*cm$/i.exec(raw.trim());
  if (match === null) return null;
  const cm = parseFloat(match[1]!);
  if (!Number.isFinite(cm) || cm <= 0) return null;
  return Math.round((cm * 96) / 2.54);
}

/** Prop key used in picture batch commands until the host resolves staged image paths. */
export const OFFICE_RUN_IMAGE_INDEX_PROP = "_imageIndex";

export function defaultInlineImageDimensions(): { width: number; height: number } {
  return { width: 200, height: 150 };
}
