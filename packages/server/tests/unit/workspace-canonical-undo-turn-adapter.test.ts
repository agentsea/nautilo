import { describe, expect, test } from "bun:test";
import type {
  WorkspaceDocumentHistoryRecord,
} from "@nautilo/db";
import {
  selectWorkspaceUndoTurnArtifact,
  workspaceUndoTurnTargetsCurrentTurn,
} from "../../src/document-mutations/workspace-canonical-undo-turn-adapter";
import type { WorkspaceCanonicalUndoTurnRequest } from "@nautilo/agent";

function record(input: {
  readonly id: string;
  readonly turnId: string;
  readonly operation?: string;
  readonly artifactId?: string;
  readonly restoreFromEntryId?: string | null;
  readonly overwrite?: boolean;
}): WorkspaceDocumentHistoryRecord {
  return {
    mutation: { turnId: input.turnId },
    entry: {
      id: input.id,
      artifactInternalId: input.artifactId ?? "artifact-1",
      historyOperation: input.operation ?? "file_tool",
      restoreFromEntryId: input.restoreFromEntryId ?? null,
      destinationBeforeArtifactInternalId:
        input.overwrite === true ? "overwritten-artifact" : null,
    },
    revisionId: `revision-${input.id}`,
  } as unknown as WorkspaceDocumentHistoryRecord;
}

describe("canonical Workspace undo_turn selection", () => {
  test("rejects targeting the same turn that would record the restore", () => {
    expect(workspaceUndoTurnTargetsCurrentTurn({
      authority: { turnId: "current-turn" },
      targetTurnId: "current-turn",
    } as unknown as WorkspaceCanonicalUndoTurnRequest)).toBe(true);
    expect(workspaceUndoTurnTargetsCurrentTurn({
      authority: { turnId: "current-turn" },
      targetTurnId: "older-turn",
    } as unknown as WorkspaceCanonicalUndoTurnRequest)).toBe(false);
  });

  test("selects one contiguous active same-turn suffix and collapses to its earliest entry", () => {
    const base = record({ id: "base", turnId: "base-turn" });
    const first = record({ id: "first", turnId: "target-turn" });
    const second = record({ id: "second", turnId: "target-turn" });
    expect(selectWorkspaceUndoTurnArtifact({
      artifactInternalId: "artifact-1",
      targetTurnId: "target-turn",
      targetRecords: [first, second],
      lineage: {
        kind: "valid",
        undo: [base, first, second],
        redo: [],
        current: second,
      },
    })).toEqual({
      kind: "selected",
      selection: {
        artifactInternalId: "artifact-1",
        current: second,
        earliest: first,
        restoreFromEntryId: "second",
      },
    });
  });

  test("rejects later/interleaved, inactive, restore, and overwrite-move target lineage", () => {
    const first = record({ id: "first", turnId: "target-turn" });
    const later = record({ id: "later", turnId: "later-turn" });
    const baseLineage = {
      kind: "valid" as const,
      undo: [first, later],
      redo: [],
      current: later,
    };
    expect(selectWorkspaceUndoTurnArtifact({
      artifactInternalId: "artifact-1",
      targetTurnId: "target-turn",
      targetRecords: [first],
      lineage: baseLineage,
    }).kind).toBe("ineligible");
    expect(selectWorkspaceUndoTurnArtifact({
      artifactInternalId: "artifact-1",
      targetTurnId: "target-turn",
      targetRecords: [first],
      lineage: {
        kind: "valid",
        undo: [],
        redo: [first],
        current: first,
      },
    }).kind).toBe("ineligible");
    for (const invalid of [
      record({
        id: "restore",
        turnId: "target-turn",
        operation: "undo",
        restoreFromEntryId: "first",
      }),
      record({
        id: "overwrite",
        turnId: "target-turn",
        overwrite: true,
      }),
    ]) {
      expect(selectWorkspaceUndoTurnArtifact({
        artifactInternalId: "artifact-1",
        targetTurnId: "target-turn",
        targetRecords: [invalid],
        lineage: {
          kind: "valid",
          undo: [invalid],
          redo: [],
          current: invalid,
        },
      }).kind).toBe("ineligible");
    }
  });
});
