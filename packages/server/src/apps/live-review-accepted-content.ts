import { isDeepStrictEqual } from "node:util";
import {
  applyDocumentOperations,
  parseWriterHtml,
  serializeCanonicalWriterHtml,
  type ResolvedProposalOperation,
  type WriterHtmlManifest,
} from "@nautilo/writer-proposal-core";
import type { LiveReviewExtension } from "./live-review-extension-registry";

function nonVolatileManifest(manifest: WriterHtmlManifest): unknown {
  const copy = structuredClone(manifest);
  if (copy.metadata) {
    delete copy.metadata.updatedAt;
    if (Object.keys(copy.metadata).length === 0) delete copy.metadata;
  }
  return copy;
}

function canonicalAcceptedManifest(
  canonical: WriterHtmlManifest,
  accepted: WriterHtmlManifest,
): WriterHtmlManifest | null {
  if (!isDeepStrictEqual(nonVolatileManifest(canonical), nonVolatileManifest(accepted))) {
    return null;
  }
  const acceptedMetadata = accepted.metadata as Record<string, unknown> | undefined;
  const carriesUpdatedAt =
    acceptedMetadata !== undefined &&
    Object.prototype.hasOwnProperty.call(acceptedMetadata, "updatedAt");
  if (carriesUpdatedAt && typeof acceptedMetadata["updatedAt"] !== "string") {
    return null;
  }
  const manifest = structuredClone(canonical);
  if (carriesUpdatedAt) {
    manifest.metadata = {
      ...manifest.metadata,
      updatedAt: acceptedMetadata["updatedAt"] as string,
    };
  }
  return manifest;
}

/**
 * One canonical verifier for both Workspace Artifact and Current Folder
 * acceptance. Client-submitted bytes are never write authority: the server
 * replays the selected, preflighted proposal operations over the current
 * canonical document and requires the submitted result to match exactly.
 */
export function verifyAcceptedLiveReviewContent(input: {
  canonicalContent: string;
  acceptedContent: string;
  selectedOperations: readonly unknown[];
  extension: LiveReviewExtension;
}): { ok: true; canonicalAcceptedContent: string } | { ok: false } {
  const parsedCanonical = parseWriterHtml(input.canonicalContent);
  const parsedAccepted = parseWriterHtml(input.acceptedContent);
  if (!parsedCanonical.ok || !parsedAccepted.ok) return { ok: false };

  const selectedPreflight = input.extension.preflightProposal(
    input.canonicalContent,
    [...input.selectedOperations],
  );
  if (!selectedPreflight.ok) return { ok: false };

  const expected = applyDocumentOperations(
    parsedCanonical.document.document as Parameters<typeof applyDocumentOperations>[0],
    selectedPreflight.operations as readonly ResolvedProposalOperation[],
  );
  const acceptedManifest = canonicalAcceptedManifest(
    parsedCanonical.document.manifest,
    parsedAccepted.document.manifest,
  );
  if (
    !expected.ok ||
    !isDeepStrictEqual(expected.document, parsedAccepted.document.document) ||
    !acceptedManifest
  ) {
    return { ok: false };
  }

  try {
    return {
      ok: true,
      canonicalAcceptedContent: serializeCanonicalWriterHtml(
        acceptedManifest,
        expected.document,
      ),
    };
  } catch {
    return { ok: false };
  }
}
