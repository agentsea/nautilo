/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as WafflebaseDocs from "@nautilo/office-docs/browser";
import type {
  NautiloDocumentChangeEvent,
  NautiloLiveSessionCapability,
  NautiloWriterProposal,
} from "./bridge";
import { installWriterTestDom, wait } from "./test-dom";

function canonicalDocument(text = "Before") {
  const paragraph = WafflebaseDocs.createBlock("paragraph");
  paragraph.id = "paragraph-1";
  paragraph.inlines = [{ text, style: {} }];
  return { blocks: [paragraph] };
}

let storeMounted = false;
let editorInitialized = false;
let editorInitializeCount = 0;
let writerStoreCallbacks: {
  onLocalChange?: () => void;
  writePatch?: (input: { container: string }) => Promise<boolean>;
} | null = null;
let acceptSuggestionHandler: ((all: boolean, changeId?: string) => Promise<void>) | null = null;
let rejectSuggestionHandler: ((all: boolean, changeId?: string) => Promise<void>) | null = null;
let noEffectiveSuggestionHandler: (() => void) | null = null;
let storeHasUnsavedLocalEdits = false;
let storeDocumentText = "Before";
let resolveProposalBarrier: Promise<void> | null = null;
const renderedDocumentTexts: string[] = [];
const applyRemotePatch = mock((_content: string) => ({ ok: true as const, rebased: false }));
const flushStore = mock(async () => {
  storeHasUnsavedLocalEdits = false;
  return true;
});
const commitAcceptedBatch = mock(async () => ({ ok: true as const, persisted: true }));
const prepareAcceptedContent = mock(() => ({
  ok: true as const,
  content: "accepted writer container",
}));
const installAcceptedContent = mock(() => {
  storeDocumentText = "After";
  return { ok: true as const, rebased: false };
});
const resolveProposal = mock(async () => {
  await resolveProposalBarrier;
  return { ok: true as const, taskStatus: "completed" };
});
const acknowledgeProposal = mock((_input: unknown) => {});
const invalidateProposal = mock(async () => ({ ok: true as const, taskStatus: "cancelled" }));
const humanEditSet = mock((_update: unknown) => {});
let documentWriteResult:
  | { kind: "saved"; sha256: string; revision: number }
  | { kind: "conflict"; currentSha256: string };

function TestNautiloDocStore(_initialContainer: string, deps: unknown) {
  storeMounted = true;
  const callbacks = deps as {
    onLocalChange?: () => void;
    writePatch?: (input: { container: string }) => Promise<boolean>;
  };
  writerStoreCallbacks = callbacks;
  return {
    initBase: async () => {},
    getDocument: () => structuredClone(canonicalDocument(storeDocumentText)),
    hasUnsavedLocalEdits: () => storeHasUnsavedLocalEdits,
    flush: flushStore,
    applyRemotePatch,
    prepareAcceptedContent,
    installAcceptedContent,
    commitAcceptedBatch,
  };
}

// Bun resolves the package's node entry for tests, while Writer is a browser
// app. Keep this harness on the browser implementation that production uses.
mock.module("@nautilo/office-docs/browser", () => ({
  ...WafflebaseDocs,
  initialize: (_host: unknown, store: { getDocument(): ReturnType<typeof canonicalDocument> }) => {
    editorInitialized = true;
    editorInitializeCount += 1;
    renderedDocumentTexts.push(store.getDocument().blocks[0]?.inlines[0]?.text ?? "");
    return {
      onCursorMove: () => undefined,
      resetAfterDocumentReplace: () => {},
      render: () => {
        renderedDocumentTexts.push(store.getDocument().blocks[0]?.inlines[0]?.text ?? "");
      },
      focus: () => {},
    };
  },
}));

mock.module("./nautilo-doc-store", () => ({
  NautiloDocStore: TestNautiloDocStore,
}));

mock.module("./writer-doc-surface", () => ({
  WriterDocSurface: (props: {
    canvasRef?: (element: HTMLDivElement | null) => void;
    suggestionState?: Record<string, unknown>;
    banner?: ReactNode;
    onAcceptSuggestion?: (all: boolean, changeId?: string) => Promise<void>;
    onRejectSuggestion?: (all: boolean, changeId?: string) => Promise<void>;
    onNoEffectiveSuggestion?: () => void;
  }) => {
    acceptSuggestionHandler = props.onAcceptSuggestion ?? null;
    rejectSuggestionHandler = props.onRejectSuggestion ?? null;
    noEffectiveSuggestionHandler = props.onNoEffectiveSuggestion ?? null;
    const state = props.suggestionState ?? { kind: "idle" };
    const snapshot = state.kind === "pending"
      ? {
          kind: state.kind,
          proposalId: state.proposalId,
          operations: state.operations,
          selections: state.selections,
        }
      : {
          kind: state.kind,
          ...(typeof state.reason === "string" ? { reason: state.reason } : {}),
        };
    return createElement(
      "div",
      null,
      props.banner,
      createElement("div", { ref: props.canvasRef }),
      createElement("output", { id: "writer-review-snapshot" }, JSON.stringify(snapshot)),
      state.kind === "pending" && Object.keys(state.selections as object).length === 0
        ? createElement(
            "button",
            { type: "button", onClick: props.onNoEffectiveSuggestion },
            "Close review",
          )
        : null,
    );
  },
}));

const { WriterApp } = await import("./writer-app");

const CAPABILITY = {
  sessionToken: "writer-session-token",
  sessionId: "writer-session",
  documentVersion: { kind: "artifact_revision" as const, revision: 7 },
};

type DocumentChangeHandler = (event: NautiloDocumentChangeEvent) => void;
type SessionChangeHandler = (capability: NautiloLiveSessionCapability) => void;
type ProposalHandler = (proposal: NautiloWriterProposal) => void;

let root: Root | null = null;
let documentChangeHandler: DocumentChangeHandler | null = null;
let sessionChangeHandler: SessionChangeHandler | null = null;
let proposalHandler: ProposalHandler | null = null;
let envelope = {
  content: "writer container",
  path: "proposal.html",
  baseSha256: "sha-7",
  baseRevision: 7,
};

function snapshot(): Record<string, unknown> {
  const element = document.querySelector("#writer-review-snapshot");
  if (!element?.textContent) throw new Error("Writer review snapshot is not mounted.");
  return JSON.parse(element.textContent) as Record<string, unknown>;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await wait(1);
    });
  }
  throw new Error(`Timed out waiting for Writer state: ${JSON.stringify(snapshot())}`);
}

async function mountAndStageProposal({ expectPending = true }: { expectPending?: boolean } = {}): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(WriterApp));
  });
  await waitUntil(() =>
    storeMounted && editorInitialized && documentChangeHandler !== null && sessionChangeHandler !== null && proposalHandler !== null,
  );

  await act(async () => {
    sessionChangeHandler?.(CAPABILITY);
  });
  await act(async () => {
    proposalHandler?.({
      proposalId: "proposal-1",
      sessionId: CAPABILITY.sessionId,
      documentVersion: CAPABILITY.documentVersion,
      operations: [{
        kind: "replace",
        blockId: "paragraph-1",
        scope: { kind: "range", start: 0, end: 6 },
        text: "After",
      }],
    });
  });
  if (expectPending) await waitUntil(() => snapshot().kind === "pending");
}

beforeEach(() => {
  installWriterTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  documentChangeHandler = null;
  sessionChangeHandler = null;
  proposalHandler = null;
  acceptSuggestionHandler = null;
  rejectSuggestionHandler = null;
  noEffectiveSuggestionHandler = null;
  storeMounted = false;
  editorInitialized = false;
  editorInitializeCount = 0;
  storeHasUnsavedLocalEdits = false;
  storeDocumentText = "Before";
  resolveProposalBarrier = null;
  renderedDocumentTexts.length = 0;
  applyRemotePatch.mockClear();
  writerStoreCallbacks = null;
  humanEditSet.mockClear();
  commitAcceptedBatch.mockClear();
  prepareAcceptedContent.mockClear();
  installAcceptedContent.mockClear();
  resolveProposal.mockClear();
  acknowledgeProposal.mockClear();
  invalidateProposal.mockClear();
  flushStore.mockClear();
  envelope = {
    content: "writer container",
    path: "proposal.html",
    baseSha256: "sha-7",
    baseRevision: 7,
  };
  window.nautiloApp = {
    document: {
      read: async () => envelope,
      write: async () => documentWriteResult,
      onChange: (handler) => {
        documentChangeHandler = handler as DocumentChangeHandler;
        return () => {
          if (documentChangeHandler === handler) documentChangeHandler = null;
        };
      },
    },
    context: { set: () => {} },
    humanEdit: { set: humanEditSet },
    session: {
      onChange: (handler) => {
        sessionChangeHandler = handler as SessionChangeHandler;
        return () => {
          if (sessionChangeHandler === handler) sessionChangeHandler = null;
        };
      },
      onProposal: (handler) => {
        proposalHandler = handler as ProposalHandler;
        return () => {
          if (proposalHandler === handler) proposalHandler = null;
        };
      },
      onClosed: () => () => {},
      acknowledgeProposal,
      acceptProposal: async () => ({
        ok: true as const,
        documentVersion: { kind: "artifact_revision" as const, revision: 8 },
        contentSha256: "a".repeat(64),
      }),
      resolveProposal,
      invalidateProposal,
    },
  };
  documentWriteResult = { kind: "saved", sha256: envelope.baseSha256, revision: envelope.baseRevision };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});

describe("WriterApp reconnect review state", () => {
  test("publishes incident-sized dirty, saving, and conflict updates as state-only presence", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(WriterApp));
    });
    await waitUntil(() => storeMounted && editorInitialized && writerStoreCallbacks !== null);

    const syntheticIncidentContainer = "x".repeat(2_216_960);
    await act(async () => {
      writerStoreCallbacks?.onLocalChange?.();
      await writerStoreCallbacks?.writePatch?.({ container: syntheticIncidentContainer });
      documentWriteResult = { kind: "conflict", currentSha256: "remote-sha" };
      await writerStoreCallbacks?.writePatch?.({ container: syntheticIncidentContainer });
    });

    const updates = humanEditSet.mock.calls.map(([update]) => update as { state: string; draftPatch?: unknown });
    for (const state of ["dirty", "saving", "conflict"]) {
      expect(updates.some((update) => update.state === state)).toBe(true);
    }
    expect(updates.every((update) => update.draftPatch === undefined)).toBe(true);
    expect(JSON.stringify(humanEditSet.mock.calls)).not.toContain(syntheticIncidentContainer);
  });

  test("preserves a staged proposal's operations and selections across an unchanged reconnect", async () => {
    await mountAndStageProposal();
    const pendingBeforeReconnect = snapshot();
    expect(pendingBeforeReconnect.operations).toHaveLength(1);
    expect(Object.values(pendingBeforeReconnect.selections as Record<string, { selected: boolean }>))
      .toEqual([{ selected: true }, { selected: true }, { selected: true }]);

    // A no-op artifact reconnect may re-announce the unchanged capability, but
    // it must not emit a document-change event or invalidate this review.
    await act(async () => {
      sessionChangeHandler?.(CAPABILITY);
    });

    expect(snapshot()).toEqual(pendingBeforeReconnect);
  });

  test("invalidates a pending proposal for a genuine reload-required document change", async () => {
    await mountAndStageProposal();
    envelope = {
      content: "new canonical writer container",
      path: "proposal.html",
      baseSha256: "sha-8",
      baseRevision: 8,
    };

    await act(async () => {
      documentChangeHandler?.({ type: "changed", path: envelope.path, reloadRequired: true });
    });
    await waitUntil(() => snapshot().kind === "idle");

    expect(invalidateProposal).toHaveBeenCalledWith({
      proposalSessionToken: CAPABILITY.sessionToken,
      proposalId: "proposal-1",
      documentVersion: CAPABILITY.documentVersion,
      reason: "remote_changed",
    });
  });

  test("reload reconciles a lost remote invalidation before admitting a fresh review", async () => {
    await mountAndStageProposal();
    invalidateProposal.mockImplementationOnce(async () => {
      throw new Error("temporary review delivery failure");
    });
    envelope = {
      content: "remote canonical writer container",
      path: "proposal.html",
      baseSha256: "sha-8",
      baseRevision: 8,
    };

    await act(async () => {
      documentChangeHandler?.({
        type: "patch_applied",
        path: envelope.path,
        patchId: "remote-change",
        revision: 8,
        sha256: "sha-8",
        previousRevision: 7,
        previousSha256: "sha-7",
        patch: { kind: "anchored_text", oldString: "Before", newString: "Remote" },
        envelope,
      });
    });
    await waitUntil(() => snapshot().kind === "idle");

    expect(invalidateProposal).toHaveBeenCalledWith({
      proposalSessionToken: CAPABILITY.sessionToken,
      proposalId: "proposal-1",
      documentVersion: CAPABILITY.documentVersion,
      reason: "remote_changed",
    });
    expect(document.body.textContent).toContain("stale review is hidden");
    expect(document.body.textContent).toContain("Retry closing review");

    // The process dies before the user can press Retry. The transient UI state
    // is intentionally gone after reload; the server's unresolved-review
    // reconciliation replays the original proposal for Writer to close.
    await act(async () => {
      root?.unmount();
    });
    root = null;
    const reloadedHost = document.createElement("div");
    document.body.appendChild(reloadedHost);
    root = createRoot(reloadedHost);
    await act(async () => {
      root?.render(createElement(WriterApp));
    });
    await waitUntil(() =>
      storeMounted && editorInitialized && sessionChangeHandler !== null && proposalHandler !== null,
    );

    const refreshedCapability: NautiloLiveSessionCapability = {
      ...CAPABILITY,
      documentVersion: { kind: "artifact_revision", revision: 8 },
    };
    await act(async () => {
      sessionChangeHandler?.(refreshedCapability);
      proposalHandler?.({
        proposalId: "proposal-1",
        sessionId: CAPABILITY.sessionId,
        documentVersion: CAPABILITY.documentVersion,
        operations: [{
          kind: "replace",
          blockId: "paragraph-1",
          scope: { kind: "range", start: 0, end: 6 },
          text: "After",
        }],
      });
    });
    await waitUntil(() => invalidateProposal.mock.calls.length === 2);
    expect(invalidateProposal.mock.calls[1]?.[0]).toEqual({
      proposalSessionToken: CAPABILITY.sessionToken,
      proposalId: "proposal-1",
      documentVersion: CAPABILITY.documentVersion,
      reason: "stale_version",
    });
    expect(snapshot()).toEqual({ kind: "idle" });

    await act(async () => {
      proposalHandler?.({
        proposalId: "proposal-2",
        sessionId: CAPABILITY.sessionId,
        documentVersion: refreshedCapability.documentVersion,
        operations: [{
          kind: "replace",
          blockId: "paragraph-1",
          scope: { kind: "range", start: 0, end: 6 },
          text: "After remote change",
        }],
      });
    });
    await waitUntil(() => snapshot().proposalId === "proposal-2");
    expect(acknowledgeProposal).toHaveBeenLastCalledWith({
      proposalId: "proposal-2",
      documentVersion: refreshedCapability.documentVersion,
    });
  });

  test("keeps a dirty proposal retryable, then saves and enters visible review", async () => {
    storeHasUnsavedLocalEdits = true;
    await mountAndStageProposal({ expectPending: false });

    expect(snapshot()).toEqual({ kind: "idle" });
    expect(document.body.textContent).toContain("Save your edits before reviewing the suggested changes.");
    expect(acknowledgeProposal).not.toHaveBeenCalled();

    const saveAndReview = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Save and review");
    expect(saveAndReview).toBeDefined();
    await act(async () => {
      saveAndReview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitUntil(() => snapshot().kind === "pending");

    expect(flushStore).toHaveBeenCalledTimes(1);
    expect(acknowledgeProposal).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      documentVersion: CAPABILITY.documentVersion,
    });
  });

  test("closes a no-effective-change review through exact task invalidation", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(WriterApp));
    });
    await waitUntil(() =>
      storeMounted && editorInitialized && sessionChangeHandler !== null && proposalHandler !== null,
    );
    await act(async () => {
      sessionChangeHandler?.(CAPABILITY);
      proposalHandler?.({
        proposalId: "proposal-noop",
        sessionId: CAPABILITY.sessionId,
        documentVersion: CAPABILITY.documentVersion,
        operations: [{
          kind: "replace",
          blockId: "paragraph-1",
          scope: { kind: "range", start: 0, end: 6 },
          text: "Before",
        }],
      });
    });
    await waitUntil(() => snapshot().kind === "pending");

    expect(noEffectiveSuggestionHandler).toBeTypeOf("function");

    const closeReview = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Close review");
    expect(closeReview).toBeDefined();
    await act(async () => {
      closeReview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitUntil(() => snapshot().kind === "idle");

    expect(invalidateProposal).toHaveBeenCalledWith({
      proposalSessionToken: CAPABILITY.sessionToken,
      proposalId: "proposal-noop",
      documentVersion: CAPABILITY.documentVersion,
      reason: "no_effective_change",
    });
  });

  test("does not require a second renderer callback after the acceptance route saved and settled review", async () => {
    await mountAndStageProposal();
    await act(async () => {
      await acceptSuggestionHandler?.(true);
    });
    expect(prepareAcceptedContent).toHaveBeenCalledTimes(1);
    expect(installAcceptedContent).toHaveBeenCalledWith(
      "accepted writer container",
      "a".repeat(64),
    );
    expect(commitAcceptedBatch).not.toHaveBeenCalled();
    expect(resolveProposal).not.toHaveBeenCalled();
    expect(snapshot()).toEqual({ kind: "idle" });
  });

  test("repaints accepted canonical content without waiting for a second Task-resolution callback", async () => {
    await mountAndStageProposal();

    await act(async () => {
      await acceptSuggestionHandler?.(true);
      await waitUntil(() => installAcceptedContent.mock.calls.length === 1);
      await waitUntil(() => renderedDocumentTexts.includes("After"));
    });

    expect(snapshot().kind).not.toBe("pending");
    expect(renderedDocumentTexts).toContain("After");
    expect(editorInitializeCount).toBe(1);
    expect(resolveProposal).not.toHaveBeenCalled();

    await act(async () => {
      documentChangeHandler?.({
        type: "patch_applied",
        path: envelope.path,
        patchId: "late-revision-7",
        revision: 7,
        sha256: envelope.baseSha256,
        previousRevision: 6,
        previousSha256: "sha-6",
        patch: { kind: "anchored_text", oldString: "older", newString: envelope.content },
        envelope,
      });
    });
    expect(applyRemotePatch).not.toHaveBeenCalled();
    expect(renderedDocumentTexts.at(-1)).toBe("After");

    await waitUntil(() => snapshot().kind === "idle");
  });

  test("reports a full rejection as cancellation without writing the document", async () => {
    await mountAndStageProposal();
    await act(async () => {
      await rejectSuggestionHandler?.(true);
    });
    expect(commitAcceptedBatch).not.toHaveBeenCalled();
    expect(resolveProposal).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      documentVersion: CAPABILITY.documentVersion,
      outcome: "rejected",
    });
    expect(snapshot()).toEqual({ kind: "idle" });
  });
});
