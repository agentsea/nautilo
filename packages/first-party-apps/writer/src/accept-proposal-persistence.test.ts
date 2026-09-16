import { expect, test } from "bun:test";
import { createTableBlock, type Document } from "@nautilo/office-docs/node";
import { normalizeBridgeAcceptProposalResult, persistAcceptedProposal } from "./accept-proposal-persistence";
import { NautiloDocStore, type NautiloDocStoreDeps } from "./nautilo-doc-store";
import { createDefaultManifest, serializeWriterHtml } from "./office-document";
import { SuggestionController } from "./suggestion-controller";

const ARTIFACT_V7 = { kind: "artifact_revision" as const, revision: 7 };
const LOCAL_SHA = {
  kind: "local_sha" as const,
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};
const LOCAL_SHA_NEXT = {
  kind: "local_sha" as const,
  sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
};

function makeStore(onWrite: NautiloDocStoreDeps["writePatch"]): NautiloDocStore {
  return new NautiloDocStore(
    serializeWriterHtml(createDefaultManifest(), {
      blocks: [{ id: "paragraph-1", type: "paragraph", inlines: [{ text: "before", style: {} }] }],
    }),
    {
      createStore: (document) => {
        let current = structuredClone(document);
        return {
          getDocument: () => structuredClone(current),
          setDocument: (next: Document) => { current = structuredClone(next); },
          snapshot: () => undefined,
        } as unknown as ReturnType<NautiloDocStoreDeps["createStore"]>;
      },
      writePatch: onWrite,
    },
  );
}

function receivePending(
  controller: SuggestionController,
  store: NautiloDocStore,
  version = ARTIFACT_V7,
): void {
  controller.receive(
    {
      proposalId: "proposal-1",
      sessionToken: "opaque-bearer-token",
      documentVersion: version,
      operations: [{
        kind: "replace",
        blockId: "paragraph-1",
        scope: { kind: "range", start: 0, end: 6 },
        text: "after",
      }],
    },
    store.getDocument() as Document,
    version,
  );
}

function tableDocument(): Document {
  const table = createTableBlock(2, 2);
  table.id = "table";
  for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
    const cell = table.tableData!.rows[row]!.cells[col]!;
    cell.blocks[0]!.id = `table-${row}-${col}`;
    cell.blocks[0]!.inlines = [{ text: `${row}:${col}`, style: {} }];
  }
  return { blocks: [table] } as Document;
}

test("artifact accept persists through commitAcceptedBatch once", async () => {
  let writes = 0;
  const store = makeStore(() => { writes++; });
  await store.initBase();
  const controller = new SuggestionController();
  receivePending(controller, store);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: ARTIFACT_V7,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "non-authorizing-session-id",
      documentVersion: ARTIFACT_V7,
    },
  })).resolves.toEqual({ kind: "artifact_persisted" });
  expect(writes).toBe(1);
  expect(controller.getState()).toMatchObject({ kind: "completed", outcome: "accepted" });
});

test("live artifact acceptance uses the receipt bridge instead of a second document write", async () => {
  let writes = 0;
  let acceptanceCalls = 0;
  const store = makeStore(() => { writes++; });
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "artifact-receipt-1" });
  receivePending(controller, store);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: ARTIFACT_V7,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "artifact-session",
      documentVersion: ARTIFACT_V7,
    },
    bridge: {
      acceptProposal: async (request) => {
        acceptanceCalls++;
        expect(request).toMatchObject({
          requestId: "artifact-receipt-1",
          proposalId: "proposal-1",
          documentVersion: ARTIFACT_V7,
          acceptedOperationIndexes: [0],
        });
        return {
          ok: true,
          documentVersion: { kind: "artifact_revision", revision: 8 },
          contentSha256: "a".repeat(64),
        };
      },
    },
  })).resolves.toEqual({
    kind: "artifact_receipt_persisted",
    documentVersion: { kind: "artifact_revision", revision: 8 },
    contentSha256: "a".repeat(64),
  });

  expect(acceptanceCalls).toBe(1);
  expect(writes).toBe(0);
  expect(controller.getState()).toMatchObject({ kind: "completed", outcome: "accepted" });
});

test("invalidates without writing when the live bearer differs", async () => {
  let writes = 0;
  const store = makeStore(() => { writes++; });
  await store.initBase();
  const controller = new SuggestionController();
  receivePending(controller, store);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: ARTIFACT_V7,
    liveSession: {
      sessionToken: "wrong-bearer-token",
      sessionId: "non-authorizing-session-id",
      documentVersion: ARTIFACT_V7,
    },
  })).resolves.toEqual({ kind: "not_persisted" });
  expect(writes).toBe(0);
  expect(controller.getState()).toMatchObject({ kind: "invalidated", reason: "stale_version" });
});

test("local accept returns and installs the confirmed version as the next ordinary save baseline", async () => {
  let writes = 0;
  let acceptCalls = 0;
  let ordinaryWriteBase: string | undefined;
  const store = makeStore((write) => {
    writes++;
    ordinaryWriteBase = write.baseSha256;
    return write.baseSha256 === LOCAL_SHA_NEXT.sha256;
  });
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "request-1" });
  receivePending(controller, store, LOCAL_SHA);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async (request) => {
        acceptCalls++;
        expect(request).toMatchObject({
          requestId: "request-1",
          proposalId: "proposal-1",
          documentVersion: LOCAL_SHA,
          acceptedOperationIndexes: [0],
        });
        expect(request.acceptedContent).toContain("after");
        return { ok: true, documentVersion: LOCAL_SHA_NEXT, contentSha256: LOCAL_SHA_NEXT.sha256, localRevisionRef: "local:relay:abc" };
      },
    },
  })).resolves.toEqual({
    kind: "local_persisted",
    documentVersion: LOCAL_SHA_NEXT,
    contentSha256: LOCAL_SHA_NEXT.sha256,
  });

  expect(writes).toBe(0);
  expect(acceptCalls).toBe(1);
  expect(controller.getState()).toMatchObject({ kind: "completed", outcome: "accepted" });
  expect(store.getDocument().blocks[0]!.inlines[0]!.text).toBe("after");

  const edited = structuredClone(store.getDocument()) as Document;
  edited.blocks[0]!.inlines[0]!.text = "after again";
  store.setDocument(edited);
  await expect(store.flush()).resolves.toBe(true);
  expect(writes).toBe(1);
  expect(ordinaryWriteBase).toBe(LOCAL_SHA_NEXT.sha256);
});

test("partial local accept forwards only selected original operation indexes", async () => {
  const initial = serializeWriterHtml(createDefaultManifest(), {
    blocks: [
      { id: "a", type: "paragraph", inlines: [{ text: "a", style: {} }] },
      { id: "b", type: "paragraph", inlines: [{ text: "b", style: {} }] },
    ],
  });
  const store = new NautiloDocStore(initial, {
    createStore: (document) => {
      let current = structuredClone(document);
      return {
        getDocument: () => structuredClone(current),
        setDocument: (next: Document) => { current = structuredClone(next); },
        snapshot: () => undefined,
      } as unknown as ReturnType<NautiloDocStoreDeps["createStore"]>;
    },
    writePatch: () => true,
  });
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "request-partial" });
  controller.receive(
    {
      proposalId: "proposal-partial",
      sessionToken: "opaque-bearer-token",
      documentVersion: LOCAL_SHA,
      operations: [
        { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
        { kind: "replace", blockId: "b", scope: { kind: "range", start: 0, end: 1 }, text: "B" },
      ],
    },
    store.getDocument(),
    LOCAL_SHA,
  );
  const pending = controller.getState();
  if (pending.kind !== "pending") throw new Error("expected pending");
  const first = pending.changes.find((change) => change.blockId === "a")!;
  controller.setChangeSelected(first.id, false);

  let indexes: number[] = [];
  await persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async (request) => {
        indexes = [...request.acceptedOperationIndexes];
        return { ok: true, documentVersion: LOCAL_SHA_NEXT, contentSha256: LOCAL_SHA_NEXT.sha256, localRevisionRef: "local:relay:abc" };
      },
    },
  });

  expect(indexes).toEqual([1]);
});

test("local accept retry reuses the same request id after an unknown error", async () => {
  const store = makeStore(() => {});
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "retry-request" });
  receivePending(controller, store, LOCAL_SHA);

  const bridge = {
    acceptProposal: async () => ({ ok: false as const, code: "relay_unavailable", message: "lost response" }),
  };
  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge,
  })).resolves.toEqual({ kind: "not_persisted" });
  expect(controller.getState()).toMatchObject({
    kind: "pending",
    acceptRequestId: "retry-request",
    persistenceError: "lost response",
  });

  let retriedRequestId: string | undefined;
  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async (request) => {
        retriedRequestId = request.requestId;
        return { ok: true, documentVersion: LOCAL_SHA_NEXT, contentSha256: LOCAL_SHA_NEXT.sha256, localRevisionRef: "local:relay:abc" };
      },
    },
  })).resolves.toEqual({
    kind: "local_persisted",
    documentVersion: LOCAL_SHA_NEXT,
    contentSha256: LOCAL_SHA_NEXT.sha256,
  });
  expect(retriedRequestId).toBe("retry-request");
});

test("acceptance conflict preserves the pending proposal for retry", async () => {
  const store = makeStore(() => {});
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "conflict-request" });
  receivePending(controller, store, LOCAL_SHA);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async () => ({
        ok: false as const,
        code: "acceptance_conflict",
        message: "Accepted content did not match selected operations.",
      }),
    },
  })).resolves.toEqual({ kind: "not_persisted" });

  expect(controller.getState()).toMatchObject({
    kind: "pending",
    proposalId: "proposal-1",
    acceptRequestId: "conflict-request",
    persistenceError: "Accepted content did not match selected operations.",
  });
});

test("session closed invalidation leaves the canonical editor untouched", async () => {
  let writes = 0;
  const store = makeStore(() => { writes++; });
  await store.initBase();
  const before = store.getDocument().blocks[0]!.inlines[0]!.text;
  const controller = new SuggestionController();
  receivePending(controller, store, LOCAL_SHA);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async () => ({ ok: false as const, code: "session_closed", message: "closed" }),
    },
  })).resolves.toEqual({ kind: "not_persisted" });

  expect(writes).toBe(0);
  expect(controller.getState()).toMatchObject({ kind: "invalidated", reason: "session_closed" });
  expect(store.getDocument().blocks[0]!.inlines[0]!.text).toBe(before);
});

test("rejects mixed table text/shape batches and persists safe artifact batches separately", async () => {
  let writes = 0;
  const initial = serializeWriterHtml(createDefaultManifest(), tableDocument());
  const store = new NautiloDocStore(initial, {
    createStore: (document) => {
      let current = structuredClone(document);
      return {
        getDocument: () => structuredClone(current),
        setDocument: (next: Document) => { current = structuredClone(next); },
        snapshot: () => undefined,
      } as unknown as ReturnType<NautiloDocStoreDeps["createStore"]>;
    },
    writePatch: () => {
      writes++;
      return true;
    },
  });
  await store.initBase();
  const mixed = new SuggestionController();
  mixed.receive(
    {
      proposalId: "table-proposal",
      sessionToken: "opaque-bearer-token",
      documentVersion: ARTIFACT_V7,
      operations: [
        { kind: "replace", blockId: "table-0-0", scope: { kind: "range", start: 0, end: 3 }, text: "changed" },
        { kind: "insert-table-row", tableBlockId: "table", rowIndex: 2 },
      ],
    },
    store.getDocument(),
    ARTIFACT_V7,
  );

  expect(mixed.getState()).toMatchObject({ kind: "error", reason: "resolver_error" });
  await expect(persistAcceptedProposal({
    controller: mixed,
    store,
    currentDocumentVersion: ARTIFACT_V7,
    liveSession: { sessionToken: "opaque-bearer-token", sessionId: "route-only", documentVersion: ARTIFACT_V7 },
  })).resolves.toEqual({ kind: "not_persisted" });
  expect(writes).toBe(0);

  const text = new SuggestionController();
  text.receive({
    proposalId: "table-text",
    sessionToken: "opaque-bearer-token",
    documentVersion: ARTIFACT_V7,
    operations: [{ kind: "replace", blockId: "table-0-0", scope: { kind: "range", start: 0, end: 3 }, text: "changed" }],
  }, store.getDocument(), ARTIFACT_V7);
  await expect(persistAcceptedProposal({
    controller: text,
    store,
    currentDocumentVersion: ARTIFACT_V7,
    liveSession: { sessionToken: "opaque-bearer-token", sessionId: "route-only", documentVersion: ARTIFACT_V7 },
  })).resolves.toEqual({ kind: "artifact_persisted" });

  const shape = new SuggestionController();
  shape.receive({
    proposalId: "table-shape",
    sessionToken: "opaque-bearer-token",
    documentVersion: ARTIFACT_V7,
    operations: [
      { kind: "set-table-cell-style", tableBlockId: "table", cell: { rowIndex: 0, colIndex: 0 }, style: { backgroundColor: "#abc" } },
      { kind: "insert-table-row", tableBlockId: "table", rowIndex: 2 },
      { kind: "delete-table-row", tableBlockId: "table", rowIndex: 2 },
    ],
  }, store.getDocument(), ARTIFACT_V7);
  await expect(persistAcceptedProposal({
    controller: shape,
    store,
    currentDocumentVersion: ARTIFACT_V7,
    liveSession: { sessionToken: "opaque-bearer-token", sessionId: "route-only", documentVersion: ARTIFACT_V7 },
  })).resolves.toEqual({ kind: "artifact_persisted" });

  expect(writes).toBe(2);
  const table = store.getDocument().blocks[0]!.tableData!;
  expect(table.rows).toHaveLength(2);
  expect(table.columnWidths).toHaveLength(2);
  expect(table.rows[0]!.cells[0]!.blocks[0]!.inlines[0]!.text).toBe("changed");
  expect(table.rows[0]!.cells[0]!.style).toMatchObject({ backgroundColor: "#abc" });
  expect(table.rows.flatMap((row) => row.cells).every((cell) => cell.colSpan !== 0)).toBe(true);
});

test("normalizes legacy bridge rejections with [status] code into retryable failures", () => {
  expect(normalizeBridgeAcceptProposalResult(undefined, new Error("[409] acceptance_conflict"))).toEqual({
    ok: false,
    code: "acceptance_conflict",
    message: "acceptance conflict",
  });
  expect(normalizeBridgeAcceptProposalResult(undefined, new Error("[503] relay_unavailable"))).toEqual({
    ok: false,
    code: "relay_unavailable",
    message: "relay unavailable",
  });
});

test("legacy bare bridge success payloads are accepted without an ok wrapper", async () => {
  const store = makeStore(() => {});
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "legacy-request" });
  receivePending(controller, store, LOCAL_SHA);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async () => ({
        documentVersion: LOCAL_SHA_NEXT,
        contentSha256: LOCAL_SHA_NEXT.sha256,
        localRevisionRef: "local:relay:abc",
      } as never),
    },
  })).resolves.toEqual({
    kind: "local_persisted",
    documentVersion: LOCAL_SHA_NEXT,
    contentSha256: LOCAL_SHA_NEXT.sha256,
  });
  expect(controller.getState()).toMatchObject({ kind: "completed", outcome: "accepted" });
});

test("bridge rejection preserves request id for retry", async () => {
  const store = makeStore(() => {});
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "reject-request" });
  receivePending(controller, store, LOCAL_SHA);

  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async () => {
        throw new Error("[409] acceptance_conflict");
      },
    },
  })).resolves.toEqual({ kind: "not_persisted" });

  expect(controller.getState()).toMatchObject({
    kind: "pending",
    acceptRequestId: "reject-request",
    persistenceError: "acceptance conflict",
  });

  let retriedRequestId: string | undefined;
  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async (request) => {
        retriedRequestId = request.requestId;
        return { ok: true, documentVersion: LOCAL_SHA_NEXT, contentSha256: LOCAL_SHA_NEXT.sha256, localRevisionRef: "local:relay:abc" };
      },
    },
  })).resolves.toEqual({
    kind: "local_persisted",
    documentVersion: LOCAL_SHA_NEXT,
    contentSha256: LOCAL_SHA_NEXT.sha256,
  });
  expect(retriedRequestId).toBe("reject-request");
});

test("dirty canonical store invalidates local acceptance instead of posting conflicting content", async () => {
  const store = makeStore(() => {});
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "dirty-request" });
  receivePending(controller, store, LOCAL_SHA);
  const dirty = structuredClone(store.getDocument()) as Document;
  dirty.blocks[0]!.inlines[0]!.text = `human ${dirty.blocks[0]!.inlines[0]!.text}`;
  store.setDocument(dirty);

  let acceptCalls = 0;
  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async () => {
        acceptCalls++;
        return { ok: true, documentVersion: LOCAL_SHA_NEXT, contentSha256: LOCAL_SHA_NEXT.sha256, localRevisionRef: "local:relay:abc" };
      },
    },
  })).resolves.toEqual({ kind: "not_persisted" });

  expect(acceptCalls).toBe(0);
  expect(controller.getState()).toMatchObject({ kind: "invalidated", reason: "human_changed" });
});

test("two-change per-item review still posts one atomic local batch", async () => {
  const initial = serializeWriterHtml(createDefaultManifest(), {
    blocks: [
      { id: "a", type: "paragraph", inlines: [{ text: "a", style: {} }] },
      { id: "b", type: "paragraph", inlines: [{ text: "b", style: {} }] },
    ],
  });
  const store = new NautiloDocStore(initial, {
    createStore: (document) => {
      let current = structuredClone(document);
      return {
        getDocument: () => structuredClone(current),
        setDocument: (next: Document) => { current = structuredClone(next); },
        insertText: (id: string, offset: number, text: string) => {
          const block = current.blocks.find((item) => item.id === id);
          if (!block || !("inlines" in block) || !block.inlines?.[0]) return;
          const inline = block.inlines[0];
          inline.text = `${inline.text.slice(0, offset)}${text}${inline.text.slice(offset)}`;
        },
        snapshot: () => undefined,
      } as unknown as ReturnType<NautiloDocStoreDeps["createStore"]>;
    },
    writePatch: () => true,
  });
  await store.initBase();
  const controller = new SuggestionController({ createRequestId: () => "two-change-request" });
  controller.receive(
    {
      proposalId: "proposal-two",
      sessionToken: "opaque-bearer-token",
      documentVersion: LOCAL_SHA,
      operations: [
        { kind: "replace", blockId: "a", scope: { kind: "range", start: 0, end: 1 }, text: "A" },
        { kind: "replace", blockId: "b", scope: { kind: "range", start: 0, end: 1 }, text: "B" },
      ],
    },
    store.getDocument(),
    LOCAL_SHA,
  );
  const pending = controller.getState();
  if (pending.kind !== "pending") throw new Error("expected pending");
  const first = pending.changes.find((change) => change.blockId === "a")!;
  controller.acceptChangeForReview(first.id);
  const second = pending.changes.find((change) => change.blockId === "b")!;
  controller.acceptChangeForReview(second.id);

  let acceptCalls = 0;
  let acceptedIndexes: number[] = [];
  await expect(persistAcceptedProposal({
    controller,
    store,
    currentDocumentVersion: LOCAL_SHA,
    liveSession: {
      sessionToken: "opaque-bearer-token",
      sessionId: "route-only",
      documentVersion: LOCAL_SHA,
    },
    bridge: {
      acceptProposal: async (request) => {
        acceptCalls++;
        acceptedIndexes = [...request.acceptedOperationIndexes];
        return { ok: true, documentVersion: LOCAL_SHA_NEXT, contentSha256: LOCAL_SHA_NEXT.sha256, localRevisionRef: "local:relay:abc" };
      },
    },
  })).resolves.toEqual({
    kind: "local_persisted",
    documentVersion: LOCAL_SHA_NEXT,
    contentSha256: LOCAL_SHA_NEXT.sha256,
  });

  expect(acceptCalls).toBe(1);
  expect(acceptedIndexes).toEqual([0, 1]);
});
