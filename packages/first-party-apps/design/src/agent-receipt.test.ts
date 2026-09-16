import { expect, test } from "bun:test";
import {
  AgentReceiptState,
  deriveAgentReceipt,
  receiptInspectableNodeIds,
  receiptObjectDetail,
} from "./agent-receipt";
import { DesignAutosave } from "./autosave";
import { createDefaultManifest, parseDesignHtml, serializeDesignHtml } from "./design-document";
import { appendChild, createEmptyDocument, createNode, type DesignDocument } from "./scene-graph";
import { applyDesignTransaction } from "./transactions";
import { DesignStore } from "./editor/store";
import type { NautiloDocumentPatchAppliedEvent } from "./bridge";

function documentWithText(text: string): DesignDocument {
  const node = createNode({ id: "text-1", type: "text", parentId: null, text });
  return appendChild({ ...createEmptyDocument(), nodes: { "text-1": node } }, null, node.id, "page-1");
}

function content(document: DesignDocument): string {
  return serializeDesignHtml(createDefaultManifest(), document);
}

function event(
  next: string,
  author: NautiloDocumentPatchAppliedEvent["author"],
): NautiloDocumentPatchAppliedEvent {
  return {
    type: "patch_applied",
    patchId: "patch-1",
    revision: 2,
    sha256: "next-sha",
    previousRevision: 1,
    previousSha256: "base-sha",
    patch: { kind: "anchored_text", oldString: "before", newString: "after", replaceAll: true },
    ...(author !== undefined ? { author } : {}),
    envelope: { content: next, baseSha256: "next-sha", baseRevision: 2 },
  };
}

test("trusted agent and app-tool patches aggregate one readable, reversible receipt", () => {
  const before = documentWithText("before");
  const afterResult = applyDesignTransaction(before, {
    kind: "text",
    nodeId: "text-1",
    patch: { text: "after" },
  });
  if (!afterResult.ok) throw new Error(afterResult.error.message);
  const previous = { content: content(before), sha256: "base-sha" };

  for (const author of [
    { kind: "agent" as const, displayName: "Genie" },
    { kind: "app_tool" as const, displayName: "Design tool" },
  ]) {
    const receipt = deriveAgentReceipt(event(content(afterResult.document), author), previous);
    expect(receipt).toMatchObject({
      authorName: author.kind === "app_tool" ? "Genie" : author.displayName,
      changedNodeIds: ["text-1"],
      objectLabels: ["Text"],
      summary: `${author.kind === "app_tool" ? "Genie" : author.displayName} updated 1 object.`,
      patchKind: "anchored_text",
      revert: { kind: "revert" },
    });
  }
});

test("human, unattributed, stale-baseline, and structural patches do not advertise a false Revert", () => {
  const before = documentWithText("before");
  const next = documentWithText("after");
  const previous = { content: content(before), sha256: "base-sha" };
  expect(deriveAgentReceipt(event(content(next), { kind: "human", displayName: "Writer" }), previous)).toBeNull();
  expect(deriveAgentReceipt(event(content(next), undefined), previous)).toBeNull();
  expect(deriveAgentReceipt(event(content(next), { kind: "agent", displayName: "Genie" }), {
    ...previous,
    sha256: "wrong-sha",
  })).toBeNull();

  const structural = appendChild(
    { ...before, nodes: { ...before.nodes, "shape-1": createNode({ id: "shape-1", type: "rectangle", parentId: null }) } },
    null,
    "shape-1",
    "page-1",
  );
  const receipt = deriveAgentReceipt(
    event(content(structural), { kind: "app_tool", displayName: "Design tool" }),
    previous,
  );
  expect(receipt).toMatchObject({ summary: "Genie changed document structure.", revert: null });
  if (!receipt) throw new Error("Expected a structural receipt.");
  expect(receipt.objectLabels).toEqual(["Rectangle"]);
  expect(receiptInspectableNodeIds(receipt, structural)).toEqual(["shape-1"]);

  const deleted = deriveAgentReceipt(
    event(content(createEmptyDocument()), { kind: "agent", displayName: "Genie" }),
    previous,
  );
  if (!deleted) throw new Error("Expected a deletion receipt.");
  expect(receiptInspectableNodeIds(deleted, createEmptyDocument())).toEqual([]);
});

test("receipt retention is bounded to the one visible current card", () => {
  const state = new AgentReceiptState();
  const first = { patchId: "one", patchKind: "anchored_text" as const, authorName: "Genie", changedNodeIds: ["one"], objectLabels: ["One"], summary: "Genie updated 1 object.", revert: null };
  const second = { patchId: "two", patchKind: "anchored_text" as const, authorName: "Genie", changedNodeIds: ["two"], objectLabels: ["Two"], summary: "Genie updated 1 object.", revert: null };
  state.replace(first);
  state.replace(second);
  expect(state.get()).toBe(second);
  state.clear();
  expect(state.get()).toBeNull();
});

test("receipt details use bounded object names rather than durable IDs", () => {
  expect(receiptObjectDetail({
    patchId: "patch",
    patchKind: "anchored_text",
    authorName: "Genie",
    changedNodeIds: ["node-1", "node-2", "node-3", "node-4"],
    objectLabels: ["Hero", "Tagline", "CTA", "Footer"],
    summary: "Genie updated 4 objects.",
    revert: null,
  })).toBe("Updated: Hero, Tagline, CTA and 1 others");
});

test("a receipt Revert is saved and reopens as the reverted scene, while the receipt stays ephemeral", async () => {
  const before = documentWithText("before");
  const afterResult = applyDesignTransaction(before, { kind: "text", nodeId: "text-1", patch: { text: "after" } });
  if (!afterResult.ok) throw new Error(afterResult.error.message);
  const receipt = deriveAgentReceipt(
    event(content(afterResult.document), { kind: "agent", displayName: "Genie" }),
    { content: content(before), sha256: "base-sha" },
  );
  if (!receipt?.revert) throw new Error("Expected a reversible receipt.");
  const store = new DesignStore(afterResult.document, "page-1");
  expect(store.applyEphemeralRevert(receipt.revert)).toMatchObject({ ok: true, receipt: { outcome: "applied" } });
  const revertedContent = content(store.getDocument());
  let persisted = "";
  const autosave = new DesignAutosave(async (next) => {
    persisted = next;
    return { kind: "saved", sha256: "reverted", revision: 3, persistedContent: next };
  });
  autosave.markInitialLoad(content(afterResult.document), "next-sha", 2);
  autosave.notifyChange(revertedContent);
  await autosave.saveNow();
  const reopened = parseDesignHtml(persisted);
  expect(reopened.ok).toBe(true);
  if (!reopened.ok) throw new Error(reopened.error);
  expect(reopened.document.scene.nodes["text-1"]?.text).toBe("before");
  expect(new AgentReceiptState().get()).toBeNull();
  autosave.destroy();
});
