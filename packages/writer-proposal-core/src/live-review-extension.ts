import { executeProposalOperations } from "./proposal-execution";
import type { ProposalOperation } from "./proposal-contract";
import { parseWriterHtml } from "./writer-html";
import type {
  LiveDocumentReadCoverageFact,
  LiveDocumentTableReadCursor,
  LiveDocumentVersion,
} from "@nautilo/types";
import { parseLiveDocumentVersion, parseNonNegativeSafeInteger } from "@nautilo/types";

function publicDocumentVersion(raw: Record<string, unknown>): LiveDocumentVersion | null {
  const parsed = parseLiveDocumentVersion(raw["documentVersion"]);
  if (parsed) return parsed;
  const legacyRevision = parseNonNegativeSafeInteger(raw["baseRevision"]);
  if (legacyRevision !== null) {
    return { kind: "artifact_revision", revision: legacyRevision };
  }
  return null;
}

function tableCursor(value: unknown): LiveDocumentTableReadCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parts = [
    record["rowIndex"],
    record["colIndex"],
    record["blockIndex"],
    record["sliceIndex"],
  ];
  if (!parts.every((part) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0)) return null;
  return Object.freeze({
    rowIndex: parts[0] as number,
    colIndex: parts[1] as number,
    blockIndex: parts[2] as number,
    sliceIndex: parts[3] as number,
  });
}

const TABLE_START_CURSOR: LiveDocumentTableReadCursor = Object.freeze({
  rowIndex: 0,
  colIndex: 0,
  blockIndex: 0,
  sliceIndex: 0,
});

/**
 * Translate only this first-party Writer reader's successful result into a
 * structural fact. The host never infers coverage from model text or a tool
 * name: it receives this fact only after the app read canonical bytes.
 */
function readCoverageFactFromResult(input: {
  canonicalContent: string;
  args: Readonly<Record<string, unknown>>;
  result: unknown;
}): LiveDocumentReadCoverageFact | null {
  if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) return null;
  const result = input.result as Record<string, unknown>;
  if (result["ok"] !== true) return null;
  const documentVersion = publicDocumentVersion(result);
  if (!documentVersion) return null;
  const parsed = parseWriterHtml(input.canonicalContent);
  if (!parsed.ok) return null;
  const documentBlocks = (parsed.document.document as { blocks?: unknown }).blocks;
  if (!Array.isArray(documentBlocks)) return null;

  if (result["status"] === "range_read") {
    if (!Array.isArray(result["blocks"])) return null;
    const indexes = new Set<number>();
    for (const blockResult of result["blocks"]) {
      if (!blockResult || typeof blockResult !== "object" || Array.isArray(blockResult)) continue;
      const id = (blockResult as Record<string, unknown>)["id"];
      if (typeof id !== "string") continue;
      const index = documentBlocks.findIndex((candidate) =>
        candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>)["id"] === id &&
        (candidate as Record<string, unknown>)["type"] !== "table",
      );
      if (index >= 0) indexes.add(index);
    }
    if (indexes.size === 0) return null;
    return Object.freeze({
      kind: "block_range",
      documentVersion,
      blockCount: documentBlocks.length,
      blockIndexes: Object.freeze([...indexes].sort((a, b) => a - b)),
    });
  }

  if (result["status"] !== "table_read") return null;
  const table = result["table"];
  if (!table || typeof table !== "object" || Array.isArray(table)) return null;
  const tableBlockId = (table as Record<string, unknown>)["tableBlockId"];
  if (typeof tableBlockId !== "string" || input.args["blockId"] !== tableBlockId) return null;
  const tableBlockIndex = documentBlocks.findIndex((candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>)["id"] === tableBlockId &&
    (candidate as Record<string, unknown>)["type"] === "table",
  );
  if (tableBlockIndex < 0) return null;
  const cursor = input.args["tableCursor"] === undefined
    ? TABLE_START_CURSOR
    : tableCursor(input.args["tableCursor"]);
  if (!cursor) return null;
  const rawNextCursor = (table as Record<string, unknown>)["nextCursor"];
  const nextCursor = rawNextCursor === undefined ? null : tableCursor(rawNextCursor);
  if (rawNextCursor !== undefined && !nextCursor) return null;
  return Object.freeze({
    kind: "table_page",
    documentVersion,
    blockCount: documentBlocks.length,
    tableBlockIndex,
    cursor,
    nextCursor,
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
    "For a document-wide request, summary.outline is only a preview. Read the open document in bounded ranges and continue until every range across its blockCount is covered before proposing completion.",
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
