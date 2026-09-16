/**
 * D448 Phase 0.2.2 — pure byte classifier for `apply_patch` targets.
 *
 * Classification is deliberately independent of paths and extensions. A
 * filename such as `.env` can describe supported text, but that fact grants no
 * filesystem authority; routing, containment, grants, and protected-path
 * policy remain separate preflight gates.
 *
 * This module does not read files, mutate bytes, parse patch hunks, or invoke a
 * runtime. Callers must classify the exact pre-mutation bytes they already
 * obtained through an authorized path resolver.
 */

import type { ApplyPatchError } from "./contract";

export const APPLY_PATCH_UNSUPPORTED_REASONS = [
  "invalid_utf8",
  "binary_content",
  "png",
  "pdf",
  "zip_container",
  "sqlite",
] as const;

export type ApplyPatchUnsupportedReason =
  (typeof APPLY_PATCH_UNSUPPORTED_REASONS)[number];

export type ApplyPatchTextClassification =
  | {
      supported: true;
      kind: "utf8_text";
      /** Fatal-decoded text whose UTF-8 encoding is byte-for-byte identical to the input. */
      text: string;
      byteLength: number;
    }
  | {
      supported: false;
      kind: "unsupported";
      reason: ApplyPatchUnsupportedReason;
      byteLength: number;
      error: ApplyPatchError;
    };

const SIGNATURES: ReadonlyArray<{
  readonly reason: Exclude<ApplyPatchUnsupportedReason, "invalid_utf8" | "binary_content">;
  readonly label: string;
  readonly bytes: readonly number[];
}> = [
  { reason: "png", label: "PNG image", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { reason: "pdf", label: "PDF document", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { reason: "zip_container", label: "ZIP/container document", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { reason: "zip_container", label: "ZIP/container document", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { reason: "zip_container", label: "ZIP/container document", bytes: [0x50, 0x4b, 0x07, 0x08] },
  {
    reason: "sqlite",
    label: "SQLite database",
    bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00],
  },
] as const;

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function unsupported(
  reason: ApplyPatchUnsupportedReason,
  byteLength: number,
  message: string,
): ApplyPatchTextClassification {
  return {
    supported: false,
    kind: "unsupported",
    reason,
    byteLength,
    error: {
      code: "unsupported_encoding_or_type",
      message,
      retryable: false,
    },
  };
}

function containsUnsupportedControl(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    // Horizontal tab and line endings are the only C0 controls needed by
    // line-oriented source/config formats. C1 controls are likewise rejected.
    if (codePoint === 9 || codePoint === 10 || codePoint === 13) continue;
    if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

/**
 * Classify already-authorized bytes before mutation.
 *
 * `TextDecoder` runs in fatal mode, so invalid sequences never become U+FFFD.
 * `ignoreBOM:true` preserves a UTF-8 BOM as U+FEFF, allowing the round-trip
 * guard to prove that successful decoding did not alter the input bytes.
 */
export function classifyApplyPatchText(bytes: Uint8Array): ApplyPatchTextClassification {
  for (const signature of SIGNATURES) {
    if (startsWithBytes(bytes, signature.bytes)) {
      return unsupported(
        signature.reason,
        bytes.byteLength,
        `${signature.label} bytes are not supported by apply_patch; use a format-aware tool.`,
      );
    }
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return unsupported(
      "invalid_utf8",
      bytes.byteLength,
      "Target bytes are not valid UTF-8 text and cannot be edited with apply_patch.",
    );
  }

  if (containsUnsupportedControl(text)) {
    return unsupported(
      "binary_content",
      bytes.byteLength,
      "Target contains binary or unsupported control bytes and cannot be edited with apply_patch.",
    );
  }

  const roundTrip = new TextEncoder().encode(text);
  if (
    roundTrip.byteLength !== bytes.byteLength ||
    roundTrip.some((value, index) => value !== bytes[index])
  ) {
    return unsupported(
      "invalid_utf8",
      bytes.byteLength,
      "Target UTF-8 bytes cannot be decoded without changing their byte representation.",
    );
  }

  return { supported: true, kind: "utf8_text", text, byteLength: bytes.byteLength };
}
