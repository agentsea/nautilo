import { describe, expect, test } from "bun:test";
import { createBlock, createTableBlock, getBlockText, type Block, type Document } from "@nautilo/office-docs/node";
import { buildReviewProjection } from "./review-projection";
import { selectedSuggestionChanges, SuggestionController } from "./suggestion-controller";

function block(id: string, text: string): Block {
  const value = createBlock("paragraph");
  value.id = id;
  value.inlines = [{ text, style: {} }];
  return value;
}
function doc(...blocks: Block[]): Document {
  return { blocks } as Document;
}
function table(id: string): Block {
  const value = createTableBlock(2, 2);
  value.id = id;
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    value.tableData!.rows[row]!.cells[col]!.blocks[0]!.id = `${id}-${row}-${col}`;
    value.tableData!.rows[row]!.cells[col]!.blocks[0]!.inlines = [{ text: `${row}:${col}`, style: {} }];
  }
  return value;
}
const ARTIFACT_V3 = { kind: "artifact_revision" as const, revision: 3 };

function proposal(operations: unknown, overrides: Partial<{ proposalId: string; sessionToken: string; documentVersion: typeof ARTIFACT_V3 }> = {}) {
  return { proposalId: "p1", sessionToken: "token", documentVersion: ARTIFACT_V3, operations, ...overrides };
}

describe("SuggestionController", () => {
  test("stages every supported operation without changing canonical input", () => {
    const base = doc(block("a", "Hello world"), block("b", "Second"));
    const before = JSON.stringify(base);
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 6, end: 11 }, text: "earth" },
      { kind: "format-inline", blockId: "a", scope: { kind: "range", start: 0, end: 5 }, style: { bold: true } },
      { kind: "format-block", blockId: "a", scope: { kind: "block" }, style: { alignment: "center" } },
      { kind: "set-block-type", blockId: "b", scope: { kind: "block" }, blockType: { type: "heading", headingLevel: 2 } },
      { kind: "move-block", blockId: "b", destination: { position: "start" } },
    ]), base, ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind === "pending") {
      expect(state.proposedDoc.blocks.map((item) => item.id)).toEqual(["b", "a"]);
      expect(getBlockText(state.proposedDoc.blocks[1]!)).toBe("Hello earth");
      expect(state.changes.map((change) => change.kind)).toContain("move");
    }
    expect(JSON.stringify(base)).toBe(before);
  });

  test("fails closed for token/revision gates and resolver errors", () => {
    const controller = new SuggestionController();
    const base = doc(block("a", "text"));
    expect(controller.receive(proposal([{ kind: "delete", blockId: "missing", scope: { kind: "block" } }]), base, ARTIFACT_V3)).toMatchObject({ kind: "error", reason: "resolver_error" });
    controller.invalidate("session_closed");
    expect(controller.getState()).toMatchObject({ kind: "invalidated", reason: "session_closed" });
    expect(controller.receive(proposal([{ kind: "delete", blockId: "a", scope: { kind: "block" } }], { documentVersion: { kind: "artifact_revision", revision: 2 } }), base, ARTIFACT_V3)).toMatchObject({ kind: "invalidated", reason: "stale_version" });
  });

  test("builds review output from immutable-base ranges", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 4, end: 6 }, text: "X" },
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 1, end: 2 }, text: "LONG" },
    ]), doc(block("a", "abcdef")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    expect(getBlockText(state.proposedDoc.blocks[0]!)).toBe("aLONGcdX");
    expect(state.changes.map((change) => change.operationIndexes)).toContainEqual([0]);
    expect(state.changes.map((change) => change.operationIndexes)).toContainEqual([1]);
  });

  test("partial rejection rebuilds only independent selected operations", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "replace", blockId: "b", scope: { kind: "range", start: 0, end: 1 }, text: "B" },
    ]), doc(block("a", "a"), block("b", "b")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    const first = state.changes.find((change) => change.blockId === "a")!;
    const selected = controller.setChangeSelected(first.id, false);
    expect(selected).toMatchObject({ kind: "pending" });
    if (selected.kind === "pending") {
      expect(getBlockText(selected.proposedDoc.blocks[0]!)).toBe("a");
      expect(getBlockText(selected.proposedDoc.blocks[1]!)).toBe("B");
    }
    expect(controller.beginAccept()?.operations).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ kind: "accepting" });
  });

  test("rejecting one of several spans excludes their shared operation atomically", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "block" }, text: "ONE two THREE" },
    ]), doc(block("a", "one two three")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    const spans = state.changes.filter((change) => change.kind === "inline-replace");
    expect(spans).toHaveLength(2);

    const selected = controller.setChangeSelected(spans[0]!.id, false);
    expect(selected).toEqual({ kind: "completed", proposalId: "p1", outcome: "rejected" });
    expect(controller.beginAccept()).toBeNull();
  });

  test("rejecting a predecessor removes dependent same-block work and keeps move acceptance atomic", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "format-inline", blockId: "a", scope: { kind: "range", start: 1, end: 2 }, style: { bold: true } },
      { kind: "move-block", blockId: "b", destination: { position: "start" } },
    ]), doc(block("a", "ab"), block("b", "b")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    const textChange = state.changes.find((change) => change.kind === "inline-replace")!;
    const selected = controller.setChangeSelected(textChange.id, false);
    expect(selected.kind).toBe("pending");
    if (selected.kind !== "pending") return;
    expect(selected.changes.some((change) => change.kind === "inline-style")).toBe(false);
    expect(controller.beginAccept()?.operations).toEqual([
      expect.objectContaining({ kind: "move-block", blockId: "b" }),
    ]);
  });

  test("accept all does not resurrect rejected dependencies", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "format-inline", blockId: "a", scope: { kind: "range", start: 1, end: 2 }, style: { bold: true } },
      { kind: "move-block", blockId: "b", destination: { position: "start" } },
    ]), doc(block("a", "ab"), block("b", "b")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    const predecessor = state.changes.find((change) => change.kind === "inline-replace")!;
    const rejected = controller.rejectChange(predecessor.id);
    expect(rejected.kind).toBe("pending");
    if (rejected.kind !== "pending") return;
    expect(selectedSuggestionChanges(rejected).some((change) => change.kind === "inline-style")).toBe(false);

    const batch = controller.acceptAll();
    expect(batch?.operations).toHaveLength(1);
    expect(batch?.operations.map((operation) => operation.kind)).toEqual([
      "move-block",
    ]);
    expect(controller.acceptAll()).toBeNull();
  });

  test("selected-change helper skips rejected and dependency-disabled changes", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "format-inline", blockId: "a", scope: { kind: "range", start: 1, end: 2 }, style: { italic: true } },
      { kind: "replace", blockId: "b", scope: { kind: "range", start: 0, end: 1 }, text: "B" },
    ]), doc(block("a", "ab"), block("b", "b")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    const predecessor = state.changes.find((change) => change.kind === "inline-replace" && change.blockId === "a")!;
    const rejected = controller.rejectChange(predecessor.id);
    expect(rejected.kind).toBe("pending");
    if (rejected.kind !== "pending") return;
    expect(selectedSuggestionChanges(rejected).map((change) => change.blockId)).toEqual(["b"]);
  });

  test("accepting one review action advances the detached base without canonical mutation", () => {
    const controller = new SuggestionController();
    const base = doc(block("a", "a"), block("b", "b"));
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "replace", blockId: "b", scope: { kind: "range", start: 0, end: 1 }, text: "B" },
    ]), base, ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;

    const first = state.changes.find((change) => change.blockId === "a")!;
    const accepted = controller.acceptChangeForReview(first.id);
    expect(accepted.kind).toBe("pending");
    if (accepted.kind !== "pending") return;
    expect(accepted.acceptedOperationIndexes).toEqual([0]);
    expect(getBlockText(accepted.reviewBaseDoc.blocks[0]!)).toBe("A");
    expect(accepted.changes.map((change) => change.blockId)).toEqual(["b"]);
    expect(getBlockText(base.blocks[0]!)).toBe("a");

    const projection = buildReviewProjection(
      accepted.reviewBaseDoc,
      accepted.proposedDoc,
      selectedSuggestionChanges(accepted),
      accepted.operationMetadata,
    );
    expect(getBlockText(projection.document.blocks[0]!)).toBe("A");
    expect(controller.acceptAll()?.operations.map((operation) => operation.kind)).toEqual(["replace", "replace"]);
  });

  test("accepting a review item selects the next surviving item for projection scroll", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "replace", blockId: "b", scope: { kind: "range", start: 0, end: 1 }, text: "B" },
    ]), doc(block("a", "a"), block("b", "b")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;

    const first = state.changes.find((change) => change.blockId === "a")!;
    const second = state.changes.find((change) => change.blockId === "b")!;
    const result = controller.acceptChangeAndSelectNext(first.id);
    expect(result.nextChangeId).toBe(second.id);
    expect(result.state).toMatchObject({ kind: "pending" });
    if (result.state.kind === "pending") {
      expect(selectedSuggestionChanges(result.state).map((change) => change.id)).toEqual([second.id]);
    }
  });

  test("rejecting restores the source projection before selecting the next item", () => {
    const controller = new SuggestionController();
    const state = controller.receive(proposal([
      { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
      { kind: "replace", blockId: "b", scope: { kind: "range", start: 0, end: 1 }, text: "B" },
    ]), doc(block("a", "a"), block("b", "b")), ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;

    const first = state.changes.find((change) => change.blockId === "a")!;
    const second = state.changes.find((change) => change.blockId === "b")!;
    const result = controller.rejectChangeAndSelectNext(first.id);
    expect(result.nextChangeId).toBe(second.id);
    if (result.state.kind !== "pending") return;
    const projection = buildReviewProjection(
      result.state.reviewBaseDoc,
      result.state.proposedDoc,
      selectedSuggestionChanges(result.state),
      result.state.operationMetadata,
    );
    expect(getBlockText(projection.document.blocks[0]!)).toBe("a");
  });

  test("last review action returns no scroll target after it removes all items", () => {
    const controller = new SuggestionController();
    const state = controller.receive(
      proposal([{ kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" }]),
      doc(block("a", "a")),
      ARTIFACT_V3,
    );
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;

    const result = controller.acceptChangeAndSelectNext(state.changes[0]!.id);
    expect(result.nextChangeId).toBeNull();
    expect(result.state).toMatchObject({ kind: "pending", changes: [] });
    if (result.state.kind !== "pending") return;
    expect(result.state.acceptedOperationIndexes).toEqual([0]);
    expect(getBlockText(result.state.reviewBaseDoc.blocks[0]!)).toBe("A");
    expect(controller.beginAccept()?.operations).toEqual([
      expect.objectContaining({ kind: "replace", blockId: "a" }),
    ]);
    expect(controller.getState()).toMatchObject({ kind: "accepting" });
  });

  test("final individual acceptance exposes one accepted-batch intent and restores retryable review state after persistence failure", () => {
    const controller = new SuggestionController();
    const state = controller.receive(
      proposal([{ kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" }]),
      doc(block("a", "a")),
      ARTIFACT_V3,
    );
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;

    const final = controller.acceptChangeAndSelectNext(state.changes[0]!.id);
    expect(final).toMatchObject({
      nextChangeId: null,
      state: { kind: "pending", changes: [], acceptedOperationIndexes: [0] },
    });

    const batch = controller.beginAccept();
    expect(batch?.operations).toEqual([
      expect.objectContaining({ kind: "replace", blockId: "a" }),
    ]);
    controller.failAccept("p1", "persistence_error", "Network unavailable.");

    expect(controller.getState()).toMatchObject({
      kind: "pending",
      changes: [],
      acceptedOperationIndexes: [0],
      persistenceError: "Network unavailable.",
    });
  });

  test("rejecting the final review item completes rejection and restores the canonical path", () => {
    const controller = new SuggestionController();
    const state = controller.receive(
      proposal([{ kind: "replace", blockId: "a", scope: { kind: "block" }, text: "A" }]),
      doc(block("a", "a")),
      ARTIFACT_V3,
    );
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    controller.rejectChange(state.changes[0]!.id);
    expect(controller.beginAccept()).toBeNull();
    expect(controller.getState()).toEqual({ kind: "completed", proposalId: "p1", outcome: "rejected" });
  });

  test("human and remote changes invalidate without a write path", () => {
    const controller = new SuggestionController();
    controller.receive(proposal([{ kind: "insert", blockId: "a", scope: { kind: "range", start: 1, end: 1 }, text: "!" }]), doc(block("a", "a")), ARTIFACT_V3);
    controller.invalidate("human_changed");
    expect(controller.getState()).toMatchObject({ kind: "invalidated", reason: "human_changed" });
    controller.dismiss();
    expect(controller.getState()).toMatchObject({ kind: "idle" });
    controller.invalidate("remote_changed");
    expect(controller.getState()).toMatchObject({ kind: "invalidated", reason: "remote_changed" });
  });

  test("does not reuse a proposal after acceptance begins or after invalidation", () => {
    const controller = new SuggestionController();
    controller.receive(
      proposal([{ kind: "insert", blockId: "a", scope: { kind: "range", start: 1, end: 1 }, text: "!" }]),
      doc(block("a", "a")),
      ARTIFACT_V3,
    );
    const batch = controller.beginAccept();
    expect(batch?.proposalId).toBe("p1");
    expect(controller.beginAccept()).toBeNull();
    controller.invalidate("remote_changed");
    expect(controller.getState()).toMatchObject({ kind: "invalidated", reason: "remote_changed" });
    expect(controller.beginAccept()).toBeNull();
  });

  test("records completed review states without mutating the proposal base", () => {
    const controller = new SuggestionController();
    controller.receive(
      proposal([{ kind: "insert", blockId: "a", scope: { kind: "range", start: 1, end: 1 }, text: "!" }]),
      doc(block("a", "a")),
      ARTIFACT_V3,
    );
    const batch = controller.beginAccept();
    expect(batch).not.toBeNull();
    controller.completeAccept("p1");
    expect(controller.getState()).toEqual({ kind: "completed", proposalId: "p1", outcome: "accepted" });
    controller.dismiss();
    expect(controller.getState()).toEqual({ kind: "idle" });
  });

  test("keeps merge/split review decisions atomic and blocks a split after its merge is rejected", () => {
    const controller = new SuggestionController();
    const base = doc(table("table"));
    const before = JSON.stringify(base);
    const state = controller.receive(proposal([
      { kind: "merge-table-cells", tableBlockId: "table", start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 1, colIndex: 1 } },
      { kind: "split-table-cell", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 } },
    ]), base, ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    const merge = state.changes.find((change) => change.kind === "table-merge")!;
    const rejected = controller.rejectChange(merge.id);
    expect(rejected).toEqual({ kind: "completed", proposalId: "p1", outcome: "rejected" });
    expect(controller.beginAccept()).toBeNull();
    expect(JSON.stringify(base)).toBe(before);
  });

  test("reject performs no persistence side effects", () => {
    const controller = new SuggestionController();
    controller.receive(
      proposal([{ kind: "replace", blockId: "a", scope: { kind: "block" }, text: "A" }]),
      doc(block("a", "a")),
      ARTIFACT_V3,
    );
    controller.rejectAll();
    expect(controller.getState()).toMatchObject({ kind: "completed", outcome: "rejected" });
    expect(controller.beginAccept()).toBeNull();
  });

  test("rejects a table deletion as one atomic decision without canonical writes", () => {
    const controller = new SuggestionController();
    const base = doc(table("table"));
    const before = JSON.stringify(base);
    const state = controller.receive(proposal([{ kind: "delete-table", tableBlockId: "table" }]), base, ARTIFACT_V3);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    const deletion = state.changes.find((change) => change.kind === "table-delete")!;
    expect(controller.rejectChange(deletion.id)).toEqual({ kind: "completed", proposalId: "p1", outcome: "rejected" });
    expect(JSON.stringify(base)).toBe(before);
  });
});
