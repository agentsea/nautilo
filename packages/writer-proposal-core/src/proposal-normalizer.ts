import type { Document } from "@nautilo/office-docs/node";
import type { ResolvedProposalOperation, ResolvedRange } from "./proposal-resolver";

export type ProposalConflictError = {
  ok: false;
  code: "proposal_conflict";
  operationIndex: number;
  conflictingOperationIndexes: number[];
  message: string;
};

type TextOperation = Extract<ResolvedProposalOperation, { blockId: string; range: ResolvedRange }>;
type TableLike = {
  id?: unknown;
  type?: unknown;
  tableData?: { rows?: Array<{ cells?: Array<{ blocks?: Array<{ id?: unknown }> }> }> };
};

function operationIndex(operation: ResolvedProposalOperation, fallback: number): number {
  return operation.operationIndex ?? fallback;
}

function isTextOperation(operation: ResolvedProposalOperation): operation is TextOperation {
  return "blockId" in operation && "range" in operation &&
    ["insert", "delete", "replace", "format-inline"].includes(operation.kind);
}

function overlaps(left: ResolvedRange, right: ResolvedRange): boolean {
  const leftCollapsed = left.start === left.end;
  const rightCollapsed = right.start === right.end;
  // Two insertions at the same base coordinate have no deterministic model
  // order. A point on either boundary of a replacement/deletion is likewise
  // ambiguous. This also rejects a format-inline range which intersects a
  // mutation: formatting replacement text would otherwise require implicit,
  // undocumented mapping from base to generated characters.
  if (leftCollapsed && rightCollapsed) return left.start === right.start;
  if (leftCollapsed) return left.start >= right.start && left.start <= right.end;
  if (rightCollapsed) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function tableForNestedBlock(document: Pick<Document, "blocks">, blockId: string): string | null {
  for (const candidate of document.blocks as readonly TableLike[]) {
    if (candidate.type !== "table" || typeof candidate.id !== "string") continue;
    for (const row of candidate.tableData?.rows ?? []) for (const cell of row.cells ?? []) {
      if (cell.blocks?.some((block) => block.id === blockId)) return candidate.id;
    }
  }
  return null;
}

function isTableShapeOperation(operation: ResolvedProposalOperation): operation is Extract<ResolvedProposalOperation, { tableBlockId: string }> {
  return "tableBlockId" in operation && [
    "insert-table-row", "delete-table-row", "insert-table-column", "delete-table-column",
    "merge-table-cells", "split-table-cell", "delete-table",
  ].includes(operation.kind);
}

/**
 * Validates all base-coordinate edits, then returns physical application order.
 * `insert`, `delete`, `replace`, and `format-inline` are all range-sensitive
 * and must be disjoint in a text block. `format-block` and `set-block-type`
 * have whole-block, property-only semantics, so retain deterministic source
 * order and do not participate in coordinate conflict detection.
 * Returned operations retain their source `operationIndex`; only their array
 * position changes to make offset-sensitive edits safe to apply.
 */
export function normalizeProposalOperations(
  document: Pick<Document, "blocks">,
  operations: readonly ResolvedProposalOperation[],
): { ok: true; operations: ResolvedProposalOperation[] } | ProposalConflictError {
  const textByBlock = new Map<string, Array<{ operation: TextOperation; sourcePosition: number }>>();
  for (let sourcePosition = 0; sourcePosition < operations.length; sourcePosition++) {
    const operation = operations[sourcePosition]!;
    if (!isTextOperation(operation)) continue;
    const entries = textByBlock.get(operation.blockId) ?? [];
    entries.push({ operation, sourcePosition });
    textByBlock.set(operation.blockId, entries);
  }
  for (const entries of textByBlock.values()) {
    for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) {
      if (!overlaps(entries[left]!.operation.range, entries[right]!.operation.range)) continue;
      const leftIndex = operationIndex(entries[left]!.operation, entries[left]!.sourcePosition);
      const rightIndex = operationIndex(entries[right]!.operation, entries[right]!.sourcePosition);
      return {
        ok: false,
        code: "proposal_conflict",
        operationIndex: rightIndex,
        conflictingOperationIndexes: [leftIndex, rightIndex].sort((a, b) => a - b),
        message: `operations ${leftIndex} and ${rightIndex} overlap in the same base text block`,
      };
    }
  }
  for (let textPosition = 0; textPosition < operations.length; textPosition++) {
    const text = operations[textPosition]!;
    if (!isTextOperation(text)) continue;
    const tableId = tableForNestedBlock(document, text.blockId);
    if (!tableId) continue;
    for (let shapePosition = 0; shapePosition < operations.length; shapePosition++) {
      const shape = operations[shapePosition]!;
      if (!isTableShapeOperation(shape) || shape.tableBlockId !== tableId) continue;
      const textIndex = operationIndex(text, textPosition);
      const shapeIndex = operationIndex(shape, shapePosition);
      return {
        ok: false,
        code: "proposal_conflict",
        operationIndex: shapeIndex,
        conflictingOperationIndexes: [textIndex, shapeIndex].sort((a, b) => a - b),
        message: `text operation ${textIndex} and table-shape operation ${shapeIndex} target table "${tableId}"`,
      };
    }
  }

  const orderedGroups = new Map<string, ResolvedProposalOperation[]>();
  for (const [blockId, entries] of textByBlock) {
    orderedGroups.set(blockId, [...entries]
      .sort((left, right) => right.operation.range.start - left.operation.range.start ||
        operationIndex(left.operation, left.sourcePosition) - operationIndex(right.operation, right.sourcePosition))
      .map((entry) => entry.operation));
  }
  const emitted = new Set<string>();
  const ordered: ResolvedProposalOperation[] = [];
  for (const operation of operations) {
    if (!isTextOperation(operation)) {
      ordered.push(operation);
      continue;
    }
    if (emitted.has(operation.blockId)) continue;
    emitted.add(operation.blockId);
    ordered.push(...orderedGroups.get(operation.blockId)!);
  }
  return { ok: true, operations: ordered };
}
