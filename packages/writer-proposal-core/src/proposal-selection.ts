import type { Document } from "@nautilo/office-docs/node";
import {
  applyDocumentOperations,
  type DocumentOperationMetadata,
} from "./document-ops";
import type { ResolvedProposalOperation } from "./proposal-resolver";

type SelectionMetadata = Omit<DocumentOperationMetadata, "operationIndex"> & {
  operationIndex: number;
  /** Explicit members when a review decision spans several operations. */
  groupOperationIndexes?: readonly number[];
};

export type AcceptedOperationSelectionResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_indexes"
        | "invalid_metadata"
        | "group_not_closed"
        | "dependency_not_closed";
    };

const AGGREGATE_REVIEW_KINDS = new Set([
  "format-inline",
  "format-block",
  "set-block-type",
  "move-block",
  "insert-table-row",
  "delete-table-row",
  "insert-table-column",
  "delete-table-column",
  "merge-table-cells",
  "split-table-cell",
  "set-table-cell-style",
  "delete-table",
]);

const TEXT_REVIEW_KINDS = new Set(["insert", "delete", "replace"]);

type OperationTarget = {
  groupId?: string;
};

function operationTargets(
  document: Document,
  operations: readonly ResolvedProposalOperation[],
): Map<number, OperationTarget> {
  const tableWideStyleGroups = new Set(
    operations.flatMap((operation) =>
      operation.kind === "set-table-cell-style" ? [operation.tableBlockId] : [],
    ),
  );
  const nestedTargets = new Map<string, { tableId: string; cellId: string }>();
  for (const block of document.blocks) {
    if (block.type !== "table" || !block.tableData) continue;
    for (let rowIndex = 0; rowIndex < block.tableData.rows.length; rowIndex++) {
      const row = block.tableData.rows[rowIndex]!;
      for (let colIndex = 0; colIndex < row.cells.length; colIndex++) {
        for (const nested of row.cells[colIndex]!.blocks) {
          nestedTargets.set(nested.id, {
            tableId: block.id,
            cellId: `${block.id}:${rowIndex}:${colIndex}`,
          });
        }
      }
    }
  }

  const targets = new Map<number, OperationTarget>();
  for (let position = 0; position < operations.length; position++) {
    const operation = operations[position]!;
    const operationIndex = operation.operationIndex ?? position;
    if ("tableBlockId" in operation) {
      const groupId =
        operation.kind === "set-table-cell-style"
          ? `table-cell-style:${operation.tableBlockId}`
          : `${operation.kind}:${operation.tableBlockId}`;
      targets.set(operationIndex, {
        groupId,
      });
      continue;
    }
    const nested = nestedTargets.get(operation.blockId);
    if (nested) {
      const reviewKind = TEXT_REVIEW_KINDS.has(operation.kind)
        ? "table-cell-text"
        : ["format-inline", "format-block", "set-block-type"].includes(operation.kind)
          ? "table-cell-style"
          : operation.kind;
      targets.set(operationIndex, {
        groupId:
          reviewKind === "table-cell-style" && tableWideStyleGroups.has(nested.tableId)
            ? `${reviewKind}:${nested.tableId}`
            : `${reviewKind}:${nested.cellId}`,
      });
      continue;
    }
    targets.set(operationIndex, {
      ...(AGGREGATE_REVIEW_KINDS.has(operation.kind)
        ? { groupId: `${operation.kind}:${operation.blockId}` }
        : {}),
    });
  }
  return targets;
}

/** Adds the dependency/group facts needed to validate a later index subset. */
export function buildProposalSelectionMetadata(
  document: Document,
  operations: readonly ResolvedProposalOperation[],
  metadata: readonly DocumentOperationMetadata[],
): DocumentOperationMetadata[] {
  const targets = operationTargets(document, operations);
  const operationsByIndex = new Map(
    operations.map((operation, position) => [
      operation.operationIndex ?? position,
      operation,
    ]),
  );
  const ordered = metadata
    .map((entry, position) => ({
      ...entry,
      operationIndex: entry.operationIndex ?? position,
    }))
    .sort((left, right) => left.operationIndex - right.operationIndex);
  const groupIds = new Map<number, string>();
  for (const entry of ordered) {
    const groupId = targets.get(entry.operationIndex)?.groupId;
    if (groupId) groupIds.set(entry.operationIndex, groupId);
  }
  const textByBlock = new Map<string, DocumentOperationMetadata[]>();
  for (const entry of ordered) {
    if (
      groupIds.has(entry.operationIndex) ||
      !TEXT_REVIEW_KINDS.has(entry.kind) ||
      !entry.range
    ) {
      continue;
    }
    const entries = textByBlock.get(entry.blockId) ?? [];
    entries.push(entry);
    textByBlock.set(entry.blockId, entries);
  }
  for (const [blockId, entries] of textByBlock) {
    entries.sort((left, right) => left.range!.start - right.range!.start);
    let component: DocumentOperationMetadata[] = [];
    let componentEnd = -1;
    const emit = () => {
      if (component.length <= 1) return;
      const indexes = component.map((entry) => entry.operationIndex!);
      const groupId = `text:${blockId}:${indexes.join(",")}`;
      for (const index of indexes) groupIds.set(index, groupId);
    };
    for (const entry of entries) {
      if (component.length > 0 && entry.range!.start > componentEnd) {
        emit();
        component = [];
      }
      component.push(entry);
      componentEnd = Math.max(componentEnd, entry.range!.end);
    }
    emit();
  }
  return ordered.map((entry) => {
    const target = targets.get(entry.operationIndex);
    const operation = operationsByIndex.get(entry.operationIndex);
    if (!target || !operation) return entry;
    // Text/range operations were resolved against one immutable base and the
    // normalizer already rejected overlaps, so target proximity is not a
    // dependency. Only table operations can require earlier shape mutations.
    const candidates = ordered
      .filter((predecessor) => predecessor.operationIndex < entry.operationIndex)
      .flatMap((predecessor) => {
        const predecessorOperation = operationsByIndex.get(predecessor.operationIndex);
        return predecessorOperation &&
          "tableBlockId" in operation &&
          "tableBlockId" in predecessorOperation &&
          predecessorOperation.tableBlockId === operation.tableBlockId
          ? [{ index: predecessor.operationIndex, operation: predecessorOperation }]
          : [];
      });
    let dependencies =
      !("tableBlockId" in operation) ||
      applyDocumentOperations(document, [operation]).ok
        ? []
        : candidates;
    for (const candidate of candidates) {
      if (!dependencies.some((dependency) => dependency.index === candidate.index)) continue;
      const withoutCandidate = dependencies.filter(
        (dependency) => dependency.index !== candidate.index,
      );
      if (
        applyDocumentOperations(
          document,
          [...withoutCandidate.map((dependency) => dependency.operation), operation],
        ).ok
      ) {
        dependencies = withoutCandidate;
      }
    }
    const dependencyOperationIndexes = dependencies.map(
      (dependency) => dependency.index,
    );
    return {
      ...entry,
      ...(groupIds.has(entry.operationIndex)
        ? { groupId: groupIds.get(entry.operationIndex)! }
        : {}),
      ...(dependencyOperationIndexes.length > 0 ? { dependencyOperationIndexes } : {}),
    };
  });
}

function isIndexArray(value: unknown, operationCount: number): value is readonly number[] {
  return Array.isArray(value) && value.every(
    (index) =>
      typeof index === "number" &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < operationCount,
  );
}

function selectionMetadata(
  value: unknown,
  operationCount: number,
): SelectionMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  const operationIndex = metadata["operationIndex"];
  if (
    typeof operationIndex !== "number" ||
    !Number.isSafeInteger(operationIndex) ||
    operationIndex < 0 ||
    operationIndex >= operationCount ||
    typeof metadata["kind"] !== "string" ||
    (!TEXT_REVIEW_KINDS.has(metadata["kind"]) &&
      !AGGREGATE_REVIEW_KINDS.has(metadata["kind"])) ||
    typeof metadata["blockId"] !== "string" ||
    metadata["blockId"].length === 0
  ) {
    return null;
  }
  const groupId = metadata["groupId"];
  if (groupId !== undefined && (typeof groupId !== "string" || groupId.length === 0)) {
    return null;
  }
  const groupOperationIndexes = metadata["groupOperationIndexes"];
  if (
    groupOperationIndexes !== undefined &&
    !isIndexArray(groupOperationIndexes, operationCount)
  ) {
    return null;
  }
  const dependencyOperationIndexes = metadata["dependencyOperationIndexes"];
  if (
    dependencyOperationIndexes !== undefined &&
    !isIndexArray(dependencyOperationIndexes, operationCount)
  ) {
    return null;
  }
  const range = metadata["range"];
  if (
    range !== undefined &&
    (
      !range ||
      typeof range !== "object" ||
      Array.isArray(range) ||
      !Number.isSafeInteger((range as Record<string, unknown>)["start"]) ||
      !Number.isSafeInteger((range as Record<string, unknown>)["end"]) ||
      ((range as Record<string, number>)["start"] ?? -1) < 0 ||
      ((range as Record<string, number>)["start"] ?? 0) >
        ((range as Record<string, number>)["end"] ?? -1)
    )
  ) {
    return null;
  }
  return metadata as SelectionMetadata;
}

function addGroup(groups: Array<Set<number>>, indexes: Iterable<number>): void {
  const next = new Set(indexes);
  if (next.size > 1) groups.push(next);
}

/**
 * Validates an untrusted original-index subset against the metadata emitted by
 * Writer preflight. Dependency and logical-review grouping rules live in the
 * metadata builder above so callers do not recreate client-specific rules.
 */
export function validateAcceptedOperationSelection(
  acceptedOperationIndexes: readonly number[],
  operationCount: number,
  rawMetadata: readonly unknown[],
): AcceptedOperationSelectionResult {
  if (
    !Number.isSafeInteger(operationCount) ||
    operationCount <= 0 ||
    acceptedOperationIndexes.length === 0 ||
    acceptedOperationIndexes.some(
      (index, position) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= operationCount ||
        (position > 0 && acceptedOperationIndexes[position - 1]! >= index),
    )
  ) {
    return { ok: false, reason: "invalid_indexes" };
  }
  if (!Array.isArray(rawMetadata) || rawMetadata.length !== operationCount) {
    return { ok: false, reason: "invalid_metadata" };
  }

  const byIndex = new Map<number, SelectionMetadata>();
  for (let position = 0; position < rawMetadata.length; position++) {
    const metadata = selectionMetadata(rawMetadata[position], operationCount);
    if (!metadata || byIndex.has(metadata.operationIndex)) {
      return { ok: false, reason: "invalid_metadata" };
    }
    byIndex.set(metadata.operationIndex, metadata);
  }
  if (byIndex.size !== operationCount) {
    return { ok: false, reason: "invalid_metadata" };
  }

  const selected = new Set(acceptedOperationIndexes);
  const ordered = [...byIndex.entries()].sort(([left], [right]) => left - right);
  for (const [operationIndex, metadata] of ordered) {
    if (!selected.has(operationIndex)) continue;
    const explicitDependencies = metadata.dependencyOperationIndexes ?? [];
    if (explicitDependencies.some((dependency) => !selected.has(dependency))) {
      return { ok: false, reason: "dependency_not_closed" };
    }
  }

  const groups: Array<Set<number>> = [];
  const explicitGroups = new Map<string, Set<number>>();
  for (const [operationIndex, metadata] of ordered) {
    if (metadata.groupId) {
      const group = explicitGroups.get(metadata.groupId) ?? new Set<number>();
      group.add(operationIndex);
      explicitGroups.set(metadata.groupId, group);
    }
    if (metadata.groupOperationIndexes) {
      addGroup(groups, [operationIndex, ...metadata.groupOperationIndexes]);
    }
  }
  for (const group of explicitGroups.values()) addGroup(groups, group);

  for (const group of groups) {
    const selectedMembers = [...group].filter((index) => selected.has(index)).length;
    if (selectedMembers > 0 && selectedMembers !== group.size) {
      return { ok: false, reason: "group_not_closed" };
    }
  }
  return { ok: true };
}
