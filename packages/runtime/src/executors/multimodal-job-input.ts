import type { ChatMultimodalImagePart } from "@nautilo/types";
import {
  attachmentFilenameExceedsUtf8Policy,
  attachmentIdExceedsUtf8Policy,
  maxChatImageBase64CharLength,
  normalizeAcceptedChatImageMime,
} from "@nautilo/attachments";
import { warn } from "@nautilo/logger";

const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && STRICT_BASE64_RE.test(value);
}

/**
 * Parse `Job.input.multimodalImages` defensively. Drops illegal entries so forged
 * job payloads cannot inject arbitrary data-URL MIME clauses or huge blobs.
 */
export function parseMultimodalImagesFromJobInput(raw: unknown): ChatMultimodalImagePart[] {
  if (!Array.isArray(raw)) return [];
  const maxB64 = maxChatImageBase64CharLength();
  const out: ChatMultimodalImagePart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o["type"] !== "image") continue;
    const attachmentId = typeof o["attachmentId"] === "string" ? o["attachmentId"].trim() : "";
    const filename = typeof o["filename"] === "string" ? o["filename"].trim() : "";
    const mimeRaw = typeof o["mimeType"] === "string" ? o["mimeType"] : "";
    const base64Raw = typeof o["base64"] === "string" ? o["base64"] : "";
    if (!attachmentId || !filename) continue;
    if (attachmentIdExceedsUtf8Policy(attachmentId) || attachmentFilenameExceedsUtf8Policy(filename)) {
      warn("[multimodal-job-input] skipped image: id or filename exceeds UTF-8 byte policy");
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(attachmentId) || /[\u0000-\u001F\u007F]/.test(filename)) {
      warn("[multimodal-job-input] skipped image with control chars in id/filename");
      continue;
    }
    const mimeType = normalizeAcceptedChatImageMime(mimeRaw);
    if (!mimeType) {
      warn(`[multimodal-job-input] skipped image with disallowed mime: ${mimeRaw.slice(0, 48)}`);
      continue;
    }
    const base64 = base64Raw.replace(/\s/g, "");
    if (!base64) continue;
    if (base64.length > maxB64) {
      warn("[multimodal-job-input] skipped image: base64 exceeds cap");
      continue;
    }
    if (!isStrictBase64(base64)) {
      warn("[multimodal-job-input] skipped image: invalid base64 alphabet");
      continue;
    }
    out.push({ type: "image", attachmentId, filename, mimeType, base64 });
  }
  return out;
}
