import { describe, expect, test } from "bun:test";
import {
  reduceWorkspaceDocumentHistoryLineage,
  type WorkspaceDocumentHistoryRecord,
} from "../../src/queries/workspace-document-history";

function historyRecord(
  entryId: string,
  historyOperation: string,
  restoreFromEntryId: string | null = null,
): WorkspaceDocumentHistoryRecord {
  return {
    mutation: { turnId: `turn-${entryId}` },
    entry: {
      id: entryId,
      historyOperation,
      restoreFromEntryId,
    },
    revisionId: `revision-${entryId}`,
  } as unknown as WorkspaceDocumentHistoryRecord;
}

describe("canonical Workspace history lineage", () => {
  test("supports multi-step undo followed by redo in stack order", () => {
    const forwardA = historyRecord("A", "file_tool");
    const forwardB = historyRecord("B", "file_tool");
    const undoB = historyRecord("undo-B", "undo", "B");
    const undoA = historyRecord("undo-A", "undo", "A");
    const redoA = historyRecord("redo-A", "redo", "undo-A");
    const redoB = historyRecord("redo-B", "redo", "undo-B");

    expect(reduceWorkspaceDocumentHistoryLineage([forwardA, forwardB]))
      .toEqual({
        kind: "valid",
        undo: [forwardA, forwardB],
        redo: [],
        current: forwardB,
      });
    expect(
      reduceWorkspaceDocumentHistoryLineage([forwardA, forwardB, undoB]),
    ).toEqual({
      kind: "valid",
      undo: [forwardA],
      redo: [undoB],
      current: undoB,
    });
    expect(
      reduceWorkspaceDocumentHistoryLineage([
        forwardA,
        forwardB,
        undoB,
        undoA,
      ]),
    ).toEqual({
      kind: "valid",
      undo: [],
      redo: [undoB, undoA],
      current: undoA,
    });
    expect(
      reduceWorkspaceDocumentHistoryLineage([
        forwardA,
        forwardB,
        undoB,
        undoA,
        redoA,
      ]),
    ).toEqual({
      kind: "valid",
      undo: [redoA],
      redo: [undoB],
      current: redoA,
    });
    expect(
      reduceWorkspaceDocumentHistoryLineage([
        forwardA,
        forwardB,
        undoB,
        undoA,
        redoA,
        redoB,
      ]),
    ).toEqual({
      kind: "valid",
      undo: [redoA, redoB],
      redo: [],
      current: redoB,
    });
  });

  test("clears redo history after a new forward mutation", () => {
    const forwardA = historyRecord("A", "file_tool");
    const forwardB = historyRecord("B", "file_tool");
    const undoB = historyRecord("undo-B", "undo", "B");
    const forwardC = historyRecord("C", "file_tool");

    expect(
      reduceWorkspaceDocumentHistoryLineage([
        forwardA,
        forwardB,
        undoB,
        forwardC,
      ]),
    ).toEqual({
      kind: "valid",
      undo: [forwardA, forwardC],
      redo: [],
      current: forwardC,
    });
  });

  test("fails closed on non-top undo and redo restore pointers", () => {
    expect(
      reduceWorkspaceDocumentHistoryLineage([
        historyRecord("A", "file_tool"),
        historyRecord("B", "file_tool"),
        historyRecord("undo-A", "undo", "A"),
      ]),
    ).toEqual({ kind: "broken", entryId: "undo-A" });

    expect(
      reduceWorkspaceDocumentHistoryLineage([
        historyRecord("A", "file_tool"),
        historyRecord("undo-A", "undo", "A"),
        historyRecord("redo-wrong", "redo", "A"),
      ]),
    ).toEqual({ kind: "broken", entryId: "redo-wrong" });
  });

  test("undo_turn consumes only one contiguous forward suffix from its pointed source turn", () => {
    const base = historyRecord("base", "file_tool");
    const turnA = {
      ...historyRecord("A", "file_tool"),
      mutation: { turnId: "target-turn" },
    } as WorkspaceDocumentHistoryRecord;
    const turnB = {
      ...historyRecord("B", "file_tool"),
      mutation: { turnId: "target-turn" },
    } as WorkspaceDocumentHistoryRecord;
    const undone = historyRecord("undo-turn", "undo_turn", "B");
    expect(
      reduceWorkspaceDocumentHistoryLineage([base, turnA, turnB, undone]),
    ).toEqual({
      kind: "valid",
      undo: [base],
      redo: [undone],
      current: undone,
    });

    const interleaved = historyRecord("interleaved", "file_tool");
    expect(
      reduceWorkspaceDocumentHistoryLineage([
        base,
        turnA,
        interleaved,
        turnB,
        undone,
      ]),
    ).toEqual({ kind: "broken", entryId: "undo-turn" });

    const restoredTarget = {
      ...historyRecord("target-undo", "undo", "A"),
      mutation: { turnId: "target-turn" },
    } as WorkspaceDocumentHistoryRecord;
    const redoneTarget = {
      ...historyRecord("target-redo", "redo", "target-undo"),
      mutation: { turnId: "target-turn" },
    } as WorkspaceDocumentHistoryRecord;
    const invalidBatch = historyRecord(
      "invalid-batch",
      "undo_turn",
      "target-redo",
    );
    expect(
      reduceWorkspaceDocumentHistoryLineage([
        base,
        turnA,
        restoredTarget,
        redoneTarget,
        invalidBatch,
      ]),
    ).toEqual({
      kind: "broken",
      entryId: "invalid-batch",
    });

    const selfTargetingBatch = {
      ...historyRecord("self-batch", "undo_turn", "B"),
      mutation: { turnId: "target-turn" },
    } as WorkspaceDocumentHistoryRecord;
    expect(
      reduceWorkspaceDocumentHistoryLineage([
        base,
        turnA,
        turnB,
        selfTargetingBatch,
      ]),
    ).toEqual({ kind: "broken", entryId: "self-batch" });
  });
});
