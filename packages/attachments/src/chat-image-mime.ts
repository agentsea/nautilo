import { ATTACHMENT_POLICY } from "./policy";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Normalize client/job-supplied image MIME for chat multimodal data URLs.
 * Rejects parameters/extra clauses and unknown types (prevents header injection in data URLs).
 */
export function normalizeAcceptedChatImageMime(raw: string): string | null {
  const base = raw.trim().split(";")[0]?.trim().toLowerCase() ?? "";
  const fixed = base === "image/jpg" ? "image/jpeg" : base;
  return ALLOWED.has(fixed) ? fixed : null;
}

/** Upper bound on base64 character count per image payload (aligned with `maxImageBytes`). */
export function maxChatImageBase64CharLength(): number {
  return Math.ceil(ATTACHMENT_POLICY.maxImageBytes * (4 / 3)) + 64;
}
