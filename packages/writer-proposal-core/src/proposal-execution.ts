import type { Document } from "@nautilo/office-docs/node";
import { applyDocumentOperations, type DocumentOperationMetadata, type DocumentOperationResult } from "./document-ops";
import type { ProposalOperation } from "./proposal-contract";
import { normalizeProposalOperations, type ProposalConflictError } from "./proposal-normalizer";
import { buildProposalSelectionMetadata } from "./proposal-selection";
import {
  resolveProposalOperations,
  type ProposalResolutionError,
  type ResolvedProposalOperation,
} from "./proposal-resolver";

export type ProposalExecutionResult =
  | {
    ok: true;
    document: Document;
    operations: ResolvedProposalOperation[];
    metadata: DocumentOperationMetadata[];
  }
  | ((ProposalResolutionError | ProposalConflictError) & { document: Document; stage: "resolve" })
  | (Extract<DocumentOperationResult, { ok: false }> & { stage: "apply" });

/**
 * Resolves every scope against one immutable base, rejects ambiguous batches,
 * then applies independent text edits in base-coordinate-safe physical order.
 */
export function executeProposalOperations(
  document: Document,
  operations: readonly ProposalOperation[],
): ProposalExecutionResult {
  const resolution = resolveProposalOperations(document, operations);
  if (!resolution.ok) return { ...resolution, document, stage: "resolve" };
  const normalized = normalizeProposalOperations(document, resolution.operations);
  if (!normalized.ok) return { ...normalized, document, stage: "resolve" };
  const applied = applyDocumentOperations(document, normalized.operations);
  if (!applied.ok) {
    return { ...applied, stage: "apply" };
  }
  // Review and persistence retain source proposal order; metadata records the
  // original index even though applying used normalized physical order.
  return {
    ok: true,
    document: applied.document,
    operations: [...resolution.operations].sort((left, right) => (left.operationIndex ?? 0) - (right.operationIndex ?? 0)),
    metadata: buildProposalSelectionMetadata(
      document,
      resolution.operations,
      applied.operations,
    ),
  };
}
