import { executeProposalOperations } from "./proposal-execution";
import type { ProposalOperation } from "./proposal-contract";
import { parseWriterHtml } from "./writer-html";
import { buildWriterReadEntries, writerReadFingerprint } from "./context-reader";
import type {
  LiveDocumentReadCoverageFact,
  LiveDocumentVersion,
} from "@nautilo/types";
import { liveDocumentVersionEquals, parseLiveDocumentVersion, parseNonNegativeSafeInteger } from "@nautilo/types";

function publicDocumentVersion(raw: Record<string, unknown>): LiveDocumentVersion | null {
  const parsed = parseLiveDocumentVersion(raw["documentVersion"]);
  if (parsed) return parsed;
  const legacyRevision = parseNonNegativeSafeInteger(raw["baseRevision"]);
  if (legacyRevision !== null) {
    return { kind: "artifact_revision", revision: legacyRevision };
  }
  return null;
}

/** Only exact canonical text/structure visible in the result earns read credit. */
async function readCoverageFactFromResult(input: {
  canonicalContent: string;
  args: Readonly<Record<string, unknown>>;
  result: unknown;
}): Promise<LiveDocumentReadCoverageFact | null> {
  if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) return null;
  const result = input.result as Record<string, unknown>;
  if (result["ok"] !== true || result["status"] !== "context_read") return null;
  const documentVersion = publicDocumentVersion(result);
  const requestedVersion = publicDocumentVersion(input.args as Record<string, unknown>);
  if (!documentVersion || !requestedVersion || !liveDocumentVersionEquals(documentVersion, requestedVersion)) return null;
  const parsed = parseWriterHtml(input.canonicalContent);
  if (!parsed.ok) return null;
  const document = parsed.document.document as Parameters<typeof buildWriterReadEntries>[0];
  const entries = buildWriterReadEntries(document);
  const sourceFingerprint = result["sourceFingerprint"];
  if (
    result["blockCount"] !== document.blocks.length || result["totalEntries"] !== entries.length ||
    typeof sourceFingerprint !== "string" || sourceFingerprint !== await writerReadFingerprint(input.canonicalContent) ||
    !Array.isArray(result["blocks"]) || (entries.length > 0 && result["blocks"].length === 0)
  ) return null;
  const slices: Array<{ ordinal: number; startOffset: number; endOffset: number; textLength: number }> = [];
  for (const raw of result["blocks"]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const ordinal = item["ordinal"], startOffset = item["startOffset"], endOffset = item["endOffset"];
    if (
      typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) ||
      typeof startOffset !== "number" || !Number.isSafeInteger(startOffset) ||
      typeof endOffset !== "number" || !Number.isSafeInteger(endOffset)
    ) return null;
    const entry = entries[ordinal];
    if (
      !entry || startOffset < 0 || endOffset < startOffset || endOffset > entry.textLength ||
      (startOffset === endOffset && entry.textLength !== 0) ||
      item["id"] !== entry.id || item["type"] !== entry.type || item["region"] !== entry.region ||
      item["editable"] !== entry.editable || item["textLength"] !== entry.textLength ||
      item["text"] !== entry.text.slice(startOffset, endOffset) ||
      JSON.stringify(item["tablePath"]) !== JSON.stringify(entry.tablePath) ||
      JSON.stringify(item["table"]) !== JSON.stringify(entry.table) ||
      item["headingLevel"] !== entry.headingLevel
    ) return null;
    slices.push({ ordinal, startOffset, endOffset, textLength: entry.textLength });
  }
  return Object.freeze({
    kind: "text_slices", documentVersion, blockCount: document.blocks.length,
    totalEntries: entries.length, sourceFingerprint, slices: Object.freeze(slices),
  });
}

export const writerLiveReviewExtension = {
  appId: "nautilo-writer",
  liveToolIds: ["edit-open-writer", "read-open-writer-range", "locate-open-writer-text"],
  taskDelegation: {
    mode: "eligible" as const,
    liveToolIds: ["edit-open-writer", "read-open-writer-range", "locate-open-writer-text"],
  },
  guidance:
    "For all reads of the open Writer document, including read-only summaries and quotations, use read-open-writer-range, not file.read or closed-document inspection. For a document-wide request, summary.outline is only a preview. Call read-open-writer-range with scope {kind: 'document'}. Use selection for the captured selection, section with a known headingBlockId, range with known fromBlockId/toBlockId, or block with a known blockId. The host budgets each page. Copy nextRead unchanged until complete is true for the requested scope; never invent offsets or cursors. Partial text slices are not whole blocks, and a completed section is not a completed document. Use only editable entries as edit targets. Collect independent edits across the affected blocks in one edit-open-writer operations array before submitting for review; a read page is not a proposal-size limit. For whole-block rewrites, read the entire block and use one replace operation per block with scope.kind block. On a version change, restart the read at the current version.",
  proposalToolId: "edit-open-writer",
  locatorToolId: "locate-open-writer-text",
  locatorHandleForOperation(operation: unknown): string | null {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
    const scope = (operation as { scope?: unknown }).scope;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
    const record = scope as { kind?: unknown; handle?: unknown };
    return record.kind === "locator" && typeof record.handle === "string" ? record.handle : null;
  },
  resolveLocatorOperation(payload: unknown, operation: unknown) {
    if (!payload || typeof payload !== "object" || !operation || typeof operation !== "object" || Array.isArray(operation)) {
      return { ok: false as const, code: "session_closed", message: "invalid locator payload" };
    }
    const locator = payload as { blockId?: unknown; start?: unknown; end?: unknown };
    const op = operation as { blockId?: unknown };
    if (locator.blockId !== op.blockId || typeof locator.start !== "number" || typeof locator.end !== "number") {
      return { ok: false as const, code: "session_closed", message: "locator does not match operation" };
    }
    return {
      ok: true as const,
      operation: { ...op, scope: { kind: "range", start: locator.start, end: locator.end } },
    };
  },
  locatorPayloadFromResult(result: unknown) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return { ok: false as const };
    const raw = result as Record<string, unknown>;
    if (
      raw["ok"] === false &&
      (raw["status"] === "anchor_not_found" || raw["status"] === "anchor_ambiguous")
    ) {
      return {
        ok: false as const,
        publicResult: { ok: false, status: raw["status"] },
      };
    }
    const range = raw["__range"] as { start?: unknown; end?: unknown };
    const blockId = raw["blockId"];
    const documentVersion = publicDocumentVersion(raw);
    if (
      raw["status"] !== "locator_resolved" ||
      typeof blockId !== "string" ||
      typeof range?.start !== "number" ||
      typeof range.end !== "number" ||
      documentVersion === null
    ) {
      return { ok: false as const };
    }
    return {
      ok: true as const,
      payload: { blockId, start: range.start, end: range.end },
      publicResult: { ok: true, status: "locator_resolved", documentVersion, blockId },
    };
  },
  readCoverageFactFromResult,
  preflightProposal(canonicalContent: string, operations: unknown[]) {
    const parsed = parseWriterHtml(canonicalContent);
    if (!parsed.ok) return { ok: false as const, error: { code: "invalid_scope", message: "canonical document could not be parsed" } };
    const outcome = executeProposalOperations(
      parsed.document.document as Parameters<typeof executeProposalOperations>[0],
      operations as ProposalOperation[],
    );
    if (outcome.ok) {
      return {
        ok: true as const,
        operations: outcome.operations,
        operationMetadata: outcome.metadata,
      };
    }
    return {
      ok: false as const,
      error: {
        code: outcome.code === "proposal_conflict" ? "proposal_conflict" : outcome.code === "unknown_block" ? "unknown_block" : outcome.stage === "resolve" ? outcome.code : "invalid_scope",
        ...(outcome.operationIndex === undefined ? {} : { operationIndex: outcome.operationIndex }),
        ...("conflictingOperationIndexes" in outcome ? { conflictingOperationIndexes: outcome.conflictingOperationIndexes } : {}),
        message: outcome.message,
      },
    };
  },
};
