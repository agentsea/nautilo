import type { OoxmlArchivePreflightLimits } from "./ooxml/archive-preflight";

/**
 * Security ceilings inherited from the established Workbench reader contract.
 * They are maxima, not defaults for any host (including Mobile Web).
 */
export const BROWSER_DOCUMENT_VIEWER_SECURITY_MAXIMA = Object.freeze({
  pdf: Object.freeze({
    maxSourceBytes: 25 * 1024 * 1024,
  }),
  ooxml: Object.freeze({
    maxSourceBytes: 100 * 1024 * 1024,
    maxArchiveEntries: 20_000,
    maxDeclaredTotalUncompressedBytes: 512 * 1024 * 1024,
    maxDeclaredPerEntryUncompressedBytes: 64 * 1024 * 1024,
    workerTimeoutMs: 30_000,
    totalLoadTimeoutMs: 35_000,
  }),
});

export interface BrowserDocumentViewerPdfHostPolicy {
  maxSourceBytes: number;
}

export interface BrowserDocumentViewerOoxmlHostPolicy {
  maxSourceBytes: number;
  archivePreflight: OoxmlArchivePreflightLimits;
  workerTimeoutMs: number;
  totalLoadTimeoutMs: number;
}

export type BrowserDocumentViewerHostPolicyValidationResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "exceeds_shared_maximum" };

const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

function invalidOrExceeds(
  value: number,
  maximum: number,
): BrowserDocumentViewerHostPolicyValidationResult {
  if (!isPositiveSafeInteger(value)) return { ok: false, reason: "invalid" };
  return value <= maximum
    ? { ok: true }
    : { ok: false, reason: "exceeds_shared_maximum" };
}

/** Validates an explicit PDF host policy; this package supplies no host default. */
export function validatePdfHostPolicy(
  policy: BrowserDocumentViewerPdfHostPolicy,
): BrowserDocumentViewerHostPolicyValidationResult {
  return invalidOrExceeds(
    policy.maxSourceBytes,
    BROWSER_DOCUMENT_VIEWER_SECURITY_MAXIMA.pdf.maxSourceBytes,
  );
}

/** Validates an explicit OOXML host policy; this package supplies no host default. */
export function validateOoxmlHostPolicy(
  policy: BrowserDocumentViewerOoxmlHostPolicy,
): BrowserDocumentViewerHostPolicyValidationResult {
  const maxima = BROWSER_DOCUMENT_VIEWER_SECURITY_MAXIMA.ooxml;
  const numbers = [
    [policy.maxSourceBytes, maxima.maxSourceBytes],
    [policy.archivePreflight.maxEntries, maxima.maxArchiveEntries],
    [policy.workerTimeoutMs, maxima.workerTimeoutMs],
    [policy.totalLoadTimeoutMs, maxima.totalLoadTimeoutMs],
  ] as const;
  for (const [value, maximum] of numbers) {
    const result = invalidOrExceeds(value, maximum);
    if (!result.ok) return result;
  }
  const byteLimits = [
    [
      policy.archivePreflight.maxDeclaredTotalUncompressedBytes,
      BigInt(maxima.maxDeclaredTotalUncompressedBytes),
    ],
    [
      policy.archivePreflight.maxDeclaredPerEntryUncompressedBytes,
      BigInt(maxima.maxDeclaredPerEntryUncompressedBytes),
    ],
  ] as const;
  for (const [value, maximum] of byteLimits) {
    if (value <= 0n) return { ok: false, reason: "invalid" };
    if (value > maximum) return { ok: false, reason: "exceeds_shared_maximum" };
  }
  if (
    policy.archivePreflight.maxDeclaredPerEntryUncompressedBytes >
      policy.archivePreflight.maxDeclaredTotalUncompressedBytes ||
    policy.totalLoadTimeoutMs < policy.workerTimeoutMs
  )
    return { ok: false, reason: "invalid" };
  return { ok: true };
}
