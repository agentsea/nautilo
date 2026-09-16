/**
 * M206 / Writer DOCX — stage data-URL images for office.run write and extract
 * embedded media bytes for import. Node-only (@nautilo/config/officecli).
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";

export const OFFICE_RUN_IMAGE_INDEX_PROP = "_imageIndex";

export interface OfficeRunDataUrlImageInput {
  readonly dataUrl: string;
}

export interface StageOfficeRunImagesResult {
  readonly stagedPaths: readonly string[];
  readonly resolvedOps: unknown[];
  readonly cleanup: () => Promise<void>;
}

const DATA_URL_RE =
  /^data:(image\/(?:png|jpeg|jpg|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/svg+xml"]);
export const MAX_OFFICE_RUN_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_OFFICE_RUN_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;

function normalizeMime(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  return SUPPORTED_IMAGE_MIME_TYPES.has(lower) ? lower : null;
}

function decodeDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | { error: string } {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { error: "image dataUrl must be a non-empty string" };
  }
  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (match === null) {
    return {
      error: "image dataUrl must match data:image/png|jpeg|gif|svg+xml;base64,...",
    };
  }
  const mimeType = normalizeMime(match[1]!);
  if (mimeType === null) {
    return { error: "image dataUrl MIME type is unsupported" };
  }
  const payload = match[2]!.replace(/\s+/g, "");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, "base64");
  } catch {
    return { error: "image dataUrl base64 payload is invalid" };
  }
  if (bytes.byteLength === 0) return { error: "image dataUrl decoded to zero bytes" };
  if (bytes.byteLength > MAX_OFFICE_RUN_IMAGE_BYTES) {
    return {
      error: `image is ${bytes.byteLength} bytes; max is ${MAX_OFFICE_RUN_IMAGE_BYTES} bytes`,
    };
  }
  return { mimeType, bytes };
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    default:
      return ".png";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatUnknownForError(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (typeof value === "symbol") return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value;
  }
}

function rewriteImageIndexProps(
  ops: unknown[],
  stagedPaths: readonly string[],
): unknown[] {
  return ops.map((rawOp) => {
    const op = asRecord(rawOp);
    if (op === null) return rawOp;
    const props = asRecord(op["props"]);
    if (props === null) return rawOp;
    const indexRaw = props[OFFICE_RUN_IMAGE_INDEX_PROP];
    if (indexRaw === undefined) return rawOp;
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0 || index >= stagedPaths.length) {
      throw new Error(`invalid ${OFFICE_RUN_IMAGE_INDEX_PROP}=${formatUnknownForError(indexRaw)}`);
    }
    const nextProps = { ...props };
    delete nextProps[OFFICE_RUN_IMAGE_INDEX_PROP];
    nextProps["path"] = stagedPaths[index]!;
    return { ...op, props: nextProps };
  });
}

export async function stageOfficeRunImageInputs(
  ops: unknown[],
  imageInputs: readonly OfficeRunDataUrlImageInput[] | undefined,
  scratchDir?: string,
): Promise<StageOfficeRunImagesResult | { error: string }> {
  const inputs = imageInputs ?? [];
  if (inputs.length === 0) {
    return {
      stagedPaths: [],
      resolvedOps: ops,
      cleanup: async () => {},
    };
  }

  const scratch = scratchDir ?? (await mkdtemp(join(tmpdir(), "office-run-images-")));
  const ownsScratch = scratchDir === undefined;
  if (scratchDir !== undefined) {
    await mkdir(scratch, { recursive: true });
  }
  const stagedPaths: string[] = [];
  let totalBytes = 0;

  try {
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i]!;
      const decoded = decodeDataUrl(input.dataUrl);
      if ("error" in decoded) return { error: `imageInputs[${i}]: ${decoded.error}` };
      totalBytes += decoded.bytes.byteLength;
      if (totalBytes > MAX_OFFICE_RUN_IMAGE_TOTAL_BYTES) {
        return {
          error: `total embedded image bytes would be ${totalBytes}; max is ${MAX_OFFICE_RUN_IMAGE_TOTAL_BYTES} bytes`,
        };
      }
      const filePath = join(scratch, `${i + 1}-image${extensionForMime(decoded.mimeType)}`);
      await writeFile(filePath, decoded.bytes);
      stagedPaths.push(filePath);
    }

    let resolvedOps: unknown[];
    try {
      resolvedOps = rewriteImageIndexProps(ops, stagedPaths);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    return {
      stagedPaths,
      resolvedOps,
      cleanup: async () => {
        if (ownsScratch) {
          await rm(scratch, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  } catch (err) {
    if (ownsScratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeZipPath(raw: string): string {
  return raw.replace(/^\/+/, "").replace(/\\/g, "/");
}

function parseDocumentRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const relRe = /<Relationship\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = relRe.exec(xml)) !== null) {
    const attrs = match[1] ?? "";
    const idMatch = /\bId="([^"]+)"/i.exec(attrs);
    const targetMatch = /\bTarget="([^"]+)"/i.exec(attrs);
    if (idMatch && targetMatch) {
      map.set(idMatch[1]!, normalizeZipPath(targetMatch[1]!));
    }
  }
  return map;
}

function mimeFromMediaPath(mediaPath: string): string | null {
  const lower = mediaPath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return null;
}

export interface DocxMediaEntry {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly dataUrl: string;
}

function bufferToDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

/**
 * Extract inline DOCX media keyed by relationship id (OfficeCLI `format.relId`).
 */
export function extractDocxMediaByRelId(docxBytes: Buffer): Map<string, DocxMediaEntry> {
  const out = new Map<string, DocxMediaEntry>();
  if (docxBytes.byteLength < 4) return out;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(docxBytes));
  } catch {
    return out;
  }

  const relsKey = Object.keys(entries).find((key) => key === "word/_rels/document.xml.rels");
  if (relsKey === undefined) return out;
  const relsXml = Buffer.from(entries[relsKey]!).toString("utf8");
  const relationships = parseDocumentRelationships(relsXml);

  for (const [relId, target] of relationships.entries()) {
    const mediaPath = normalizeZipPath(target);
    if (!mediaPath.startsWith("media/")) continue;
    const zipKey = Object.keys(entries).find((key) => normalizeZipPath(key) === mediaPath);
    if (zipKey === undefined) continue;
    const bytes = Buffer.from(entries[zipKey]!);
    if (bytes.byteLength === 0) continue;
    const mimeType = mimeFromMediaPath(mediaPath);
    if (mimeType === null || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) continue;
    out.set(relId, {
      bytes,
      mimeType,
      dataUrl: bufferToDataUrl(bytes, mimeType),
    });
  }

  return out;
}

export function docxMediaMapToDataUrls(map: Map<string, DocxMediaEntry>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [relId, entry] of map.entries()) {
    out[relId] = entry.dataUrl;
  }
  return out;
}
