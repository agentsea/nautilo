/**
 * Writer mini-app context-summary provider (P3.2).
 *
 * Mirrors the spirit of the Excel `context-summary.ts`: a pure function that
 * returns a compact `Record<string, unknown>` describing the open document —
 * enough for an agent to ground itself, without dumping the full payload.
 *
 * Pure and node-safe: no DOM, no host, no IO. The caller (the surface) feeds
 * in the live `WafflebaseDocumentPayload` + dirty flag.
 */
import { getBlockText, type Block, type BlockType } from "@nautilo/office-docs/node";
import type { LiveDocumentVersion } from "@nautilo/types";
import type { WafflebaseDocumentPayload } from "./office-document";

const OUTLINE_BLOCK_LIMIT = 30;
const OUTLINE_TEXT_LIMIT = 80;
const TABLE_PREVIEW_LIMIT = 80;

export type WriterLiveSessionSummary = {
  sessionToken: string;
  sessionId: string;
  documentVersion: LiveDocumentVersion;
};

export type BuildContextSummaryInput = {
  documentPath?: string;
  document: WafflebaseDocumentPayload;
  selection?: unknown;
  dirty: boolean;
  liveSession?: WriterLiveSessionSummary;
};

type OutlineEntry = {
  blockId: string;
  type: BlockType;
  headingLevel?: 1 | 2 | 3;
  text: string;
  table?: {
    rowCount: number;
    columnCount: number;
    cellCount: number;
    preview: string;
    readHint: "Use read-open-writer-range with scope {kind: 'block', blockId: this table blockId}; follow nextRead until complete.";
  };
};

export type WriterDocumentSummary = {
  documentType: "document";
  blockCount: number;
  outline: OutlineEntry[];
  /** The outline is a preview, never an implicit complete-document boundary. */
  outlineContinuation: {
    returnedBlockCount: number;
    truncated: boolean;
    readHint: "This outline is only a preview. Use read-open-writer-range with scope {kind: 'document'}; follow nextRead until complete.";
  };
  dirty: boolean;
  liveSession?: WriterLiveSessionSummary;
  openDocumentWorkflow?: string;
};

/**
 * The app-to-Workbench context envelope. Workbench accepts only documentPath
 * as a top-level string and selection/summary as JSON fields.
 */
export type WriterContextEnvelope = {
  documentPath?: string;
  selection?: unknown;
  summary: WriterDocumentSummary;
};

const OPEN_DOCUMENT_WORKFLOW =
  "This Writer document is open. Read it with read-open-writer-range, including for read-only summaries or quotations; discover and activate that tool if needed. Use scope.kind document for the whole document and copy nextRead unchanged until complete. Do not substitute file.read or closed-document inspection. For proofreading, rewrites, formatting, moves, or any change, use edit-open-writer only; it creates reviewable suggestions. Do not use path-targeted direct mutation tools.";

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

function tablePreview(block: Block): string {
  if (!block.tableData) return "";
  for (const row of block.tableData.rows) {
    for (const cell of row.cells) {
      if (cell.colSpan === 0) continue;
      for (const nested of cell.blocks) {
        const text = getBlockText(nested);
        if (text) return truncate(text, TABLE_PREVIEW_LIMIT);
      }
    }
  }
  return "";
}

export function buildContextSummary(input: BuildContextSummaryInput): WriterDocumentSummary {
  const blocks = Array.isArray(input.document.blocks) ? (input.document.blocks as Block[]) : [];
  const outline: OutlineEntry[] = blocks.slice(0, OUTLINE_BLOCK_LIMIT).map((block) => {
    const isTable = block.type === "table" && block.tableData;
    const entry: OutlineEntry = {
      blockId: block.id,
      type: block.type,
      text: isTable
        ? `Table (${block.tableData!.rows.length} rows × ${block.tableData!.columnWidths.length} columns)`
        : truncate(getBlockText(block), OUTLINE_TEXT_LIMIT),
    };
    if (isTable) {
      entry.table = {
        rowCount: block.tableData!.rows.length,
        columnCount: block.tableData!.columnWidths.length,
        cellCount: block.tableData!.rows.reduce((count, row) => count + row.cells.length, 0),
        preview: tablePreview(block),
        readHint: "Use read-open-writer-range with scope {kind: 'block', blockId: this table blockId}; follow nextRead until complete.",
      };
    }
    if (block.headingLevel !== undefined) {
      entry.headingLevel = block.headingLevel as 1 | 2 | 3;
    }
    return entry;
  });

  const result: WriterDocumentSummary = {
    documentType: "document",
    blockCount: blocks.length,
    outline,
    outlineContinuation: {
      returnedBlockCount: outline.length,
      truncated: blocks.length > outline.length,
      readHint: "This outline is only a preview. Use read-open-writer-range with scope {kind: 'document'}; follow nextRead until complete.",
    },
    dirty: input.dirty,
  };
  if (input.liveSession) {
    result.liveSession = input.liveSession;
    result.openDocumentWorkflow = OPEN_DOCUMENT_WORKFLOW;
  }
  return result;
}

export function buildContextEnvelope(input: BuildContextSummaryInput): WriterContextEnvelope {
  return {
    ...(input.documentPath ? { documentPath: input.documentPath } : {}),
    ...(input.selection !== undefined ? { selection: input.selection } : {}),
    summary: buildContextSummary(input),
  };
}
