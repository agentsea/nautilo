import type { LiveDocumentVersion } from "@nautilo/types";
import {
  liveDocumentVersionEquals,
  parseLiveDocumentVersion,
  parseNonNegativeSafeInteger,
} from "@nautilo/types";

export type { LiveDocumentVersion };
export { liveDocumentVersionEquals, parseLiveDocumentVersion };

/**
 * Ingress-only shim: live-review payloads may still carry a legacy numeric
 * Artifact revision at compatibility boundaries. New code emits documentVersion.
 */
export function parseLiveReviewDocumentVersion(value: unknown): LiveDocumentVersion | null {
  const parsed = parseLiveDocumentVersion(value);
  if (parsed) return parsed;
  const legacyRevision = parseNonNegativeSafeInteger(value);
  if (legacyRevision !== null) {
    return { kind: "artifact_revision", revision: legacyRevision };
  }
  return null;
}

export function parseProposalIngressVersion(
  raw: Record<string, unknown>,
): LiveDocumentVersion | null {
  return parseLiveReviewDocumentVersion(raw["documentVersion"] ?? raw["baseRevision"]);
}
