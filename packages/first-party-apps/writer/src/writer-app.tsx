/**
 * WriterApp — the `nautilo-writer` mini-app shell (D372 / Nautilo Office, P2).
 *
 * Wires the REAL `window.nautiloApp` bridge to a `NautiloDocStore` and the
 * Wafflebase canvas editor:
 *   - load: `bridge.document.read()` → build store from the container → mount
 *     `initialize(el, store)`; blank/`no-document` falls back to an empty doc.
 *   - save: the store debounce-flushes the serialized container; our `writePatch`
 *     forwards it to `bridge.document.write(content, { baseSha256, baseRevision })`
 *     (the host derives + broadcasts the M193 patch). Base is host-authoritative:
 *     we adopt the returned sha/revision for the next write.
 *   - inbound: `patch_applied` / `changed` events → `store.applyRemotePatch()` →
 *     `resetAfterDocumentReplace()` + `render()`; conflicts surface a banner,
 *     never clobber.
 *
 * The full editing ribbon (styles/fonts/lists/alignment/indent/tables/links/
 * images/find-replace/theme, all driving `EditorAPI`) lives in
 * `writer-doc-surface.tsx` — that file is the canonical human verb map. This
 * shell owns the bridge mount, save-status, inbound co-edit, and the agent
 * context publish (dirty flag + current selection).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { initialize, MemDocStore, type EditorAPI } from "@nautilo/office-docs/browser";
import {
  getNautiloApp,
  isNoDocumentError,
  isPatchAppliedDocumentChange,
  type NautiloAppBridge,
  type NautiloDocumentEnvelope,
  type NautiloLiveSessionCapability,
  type NautiloWriterProposal,
  type WriterSpellPreference,
} from "./bridge";
import { createEmptyWriterHtml, type WafflebaseDocumentPayload } from "./office-document";
import { NautiloDocStore } from "./nautilo-doc-store";
import { WriterDocSurface } from "./writer-doc-surface";
import { buildContextEnvelope } from "./context-summary";
import { scheduleWriterSpellRecheck } from "./writer-spellcheck";
import { SuggestionController, type SuggestionState } from "./suggestion-controller";
import { activeChangeAfterProposalTransition } from "./suggestion-overlay";
import { persistAcceptedProposal } from "./accept-proposal-persistence";
import type { LiveDocumentVersion } from "@nautilo/types";
import { liveDocumentVersionEquals } from "@nautilo/types";
import { parseProposalIngressVersion } from "./live-document-version";
import { writerRemotePostimageState } from "./writer-remote-postimage-state";

type SaveStatus = "idle" | "saving" | "saved" | "unsaved" | "conflict" | "failed";

type TaskResolution = Readonly<{
  proposalId: string;
  documentVersion: LiveDocumentVersion;
  outcome: "accepted" | "rejected";
}>;

type PendingTaskResolution = TaskResolution & Readonly<{ kind: "resolution" }>;

type ReviewInvalidationReason =
  | "human_changed"
  | "stale_version"
  | "remote_changed"
  | "session_closed"
  | "no_effective_change";

type DeferredLiveProposal = Readonly<{
  proposal: NautiloWriterProposal;
  sessionToken: string;
  documentVersion: LiveDocumentVersion;
}>;

/**
 * One exact review closure that failed to reach the server. This is UI retry
 * state, not another proposal queue: the server registry remains the source
 * of truth and replays the same proposal after a reload.
 */
type PendingReviewInvalidation = Readonly<{
  kind: "invalidation";
  proposal: DeferredLiveProposal;
  reason: ReviewInvalidationReason;
}>;

type PendingTaskLifecycleResolution =
  | PendingTaskResolution
  | PendingReviewInvalidation;

type AppPhase =
  | { kind: "loading" }
  | { kind: "no-document" }
  | { kind: "invalid"; message: string }
  | { kind: "ready" };

function shouldApplyIncomingDocumentVersion(
  current: LiveDocumentVersion | null,
  incoming: LiveDocumentVersion,
): boolean {
  if (!current || current.kind !== incoming.kind) return true;
  if (current.kind === "artifact_revision" && incoming.kind === "artifact_revision") {
    return incoming.revision > current.revision;
  }
  return !liveDocumentVersionEquals(current, incoming);
}

function parseEnvelope(value: unknown): NautiloDocumentEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record["content"] !== "string") return null;
  return {
    content: record["content"],
    path: typeof record["path"] === "string" ? record["path"] : undefined,
    baseSha256: typeof record["baseSha256"] === "string" ? record["baseSha256"] : null,
    baseRevision: typeof record["baseRevision"] === "number" ? record["baseRevision"] : null,
  };
}

function envelopeDocumentVersion(envelope: NautiloDocumentEnvelope): LiveDocumentVersion | null {
  if (typeof envelope.baseRevision === "number") {
    return { kind: "artifact_revision", revision: envelope.baseRevision };
  }
  if (typeof envelope.baseSha256 === "string" && envelope.baseSha256.length > 0) {
    return { kind: "local_sha", sha256: envelope.baseSha256 };
  }
  return null;
}

function proposalIngressVersion(proposal: NautiloWriterProposal & { baseRevision?: number }): LiveDocumentVersion | null {
  if (proposal.documentVersion) return proposal.documentVersion;
  return parseProposalIngressVersion(proposal as unknown as Record<string, unknown>);
}

export function WriterApp(): JSX.Element {
  const [phase, setPhase] = useState<AppPhase>({ kind: "loading" });
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingTaskResolution, setPendingTaskResolution] = useState<PendingTaskLifecycleResolution | null>(null);
  const [deferredLiveProposal, setDeferredLiveProposal] = useState<DeferredLiveProposal | null>(null);
  // P3 renders this in-memory review state as a view-local overlay.
  const [suggestionState, setSuggestionState] = useState<SuggestionState>({ kind: "idle" });
  const [activeSuggestionChangeId, setActiveSuggestionChangeId] = useState<string | null>(null);
  const activeSuggestionProposalIdRef = useRef<string | null>(null);

  const [editor, setEditor] = useState<EditorAPI | null>(null);
  const [spellPreference, setSpellPreference] = useState<WriterSpellPreference | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const storeRef = useRef<NautiloDocStore | null>(null);
  const editorRef = useRef<EditorAPI | null>(null);
  const initializedRef = useRef(false);
  const baseSha256Ref = useRef<string | null>(null);
  const baseRevisionRef = useRef<number | null>(null);
  const liveDocumentVersionRef = useRef<LiveDocumentVersion | null>(null);
  const documentPathRef = useRef<string | undefined>(undefined);
  // Agent-context grounding state: whether the doc has un-flushed local edits,
  // and the human's latest cursor/selection (published so an agent knows where
  // the user is working). Selection publish is debounced to avoid per-keystroke
  // churn.
  const dirtyRef = useRef(false);
  const selectionRef = useRef<unknown>(undefined);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorUnsubRef = useRef<(() => void) | null>(null);
  const liveSessionRef = useRef<NautiloLiveSessionCapability | undefined>(undefined);
  const deferredLiveProposalRef = useRef<DeferredLiveProposal | null>(null);
  const reviewInvalidationInFlightRef = useRef<string | null>(null);
  const presentLiveProposalRef = useRef<(proposal: NautiloWriterProposal) => void>(() => {});
  const suggestionControllerRef = useRef<SuggestionController | null>(null);
  if (!suggestionControllerRef.current) {
    suggestionControllerRef.current = new SuggestionController({ onStateChange: setSuggestionState });
  }

  const pendingProposalId = suggestionState.kind === "pending" ? suggestionState.proposalId : null;
  useEffect(() => {
    setActiveSuggestionChangeId((activeId) =>
      activeChangeAfterProposalTransition(activeId, activeSuggestionProposalIdRef.current, pendingProposalId),
    );
    activeSuggestionProposalIdRef.current = pendingProposalId;
  }, [pendingProposalId]);

  const mountEditor = useCallback((store: NautiloDocStore) => {
    const el = canvasRef.current;
    if (!el) return;
    storeRef.current = store;
    const editor = initialize(el, store);
    editorRef.current = editor;
    // Track the human's caret/selection for the agent context summary. Cheap on
    // move (just stash the range); the actual publish is debounced below.
    cursorUnsubRef.current?.();
    const maybeUnsub = editor.onCursorMove((pos, selection) => {
      selectionRef.current = selection ?? { anchor: pos, focus: pos };
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = setTimeout(() => publishContextRef.current(dirtyRef.current), 400);
    });
    cursorUnsubRef.current = typeof maybeUnsub === "function" ? maybeUnsub : null;
    setEditor(editor);
  }, []);

  useEffect(() => {
    const bridge = getNautiloApp();
    const fallback: WriterSpellPreference = { enabled: true, language: "en-US", personalWords: [] };
    let cancelled = false;
    const apply = (value: unknown) => {
      if (cancelled || !value || typeof value !== "object") { if (!cancelled) setSpellPreference(fallback); return; }
      const candidate = value as Partial<WriterSpellPreference>;
      if (typeof candidate.enabled !== "boolean" || candidate.language !== "en-US" || !Array.isArray(candidate.personalWords)) { setSpellPreference(fallback); return; }
      setSpellPreference({ enabled: candidate.enabled, language: "en-US", personalWords: candidate.personalWords.filter((word): word is string => typeof word === "string") });
    };
    if (!bridge?.preferences) { setSpellPreference(fallback); return; }
    void bridge.preferences.get<WriterSpellPreference>("writer.spellcheck").then(apply).catch(() => apply(fallback));
    const unsubscribe = bridge.preferences.subscribe<WriterSpellPreference>("writer.spellcheck", apply);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const updateSpellPreference = useCallback((next: WriterSpellPreference) => {
    setSpellPreference(next);
    const bridge = getNautiloApp();
    if (!bridge?.preferences) return;
    void bridge.preferences.set("writer.spellcheck", next).then(setSpellPreference).catch(() => {});
  }, []);

  const rerenderFromStore = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.resetAfterDocumentReplace();
    editor.render();
    scheduleWriterSpellRecheck(editor, { immediate: true });
  }, []);

  const notifyTaskResolution = useCallback(async (resolution: TaskResolution): Promise<boolean> => {
    const bridge = getNautiloApp();
    if (!bridge?.session?.resolveProposal) {
      setPendingTaskResolution({ kind: "resolution", ...resolution });
      return false;
    }
    try {
      await bridge.session.resolveProposal(resolution);
      setPendingTaskResolution((pending) =>
        pending?.kind === "resolution" &&
        pending.proposalId === resolution.proposalId &&
        pending.outcome === resolution.outcome
          ? null
          : pending,
      );
      return true;
    } catch {
      // Persistence/rejection already happened. Keep the exact non-authorizing
      // receipt in memory so the Human can safely retry the idempotent Task
      // transition instead of leaving it parked without an explanation.
      setPendingTaskResolution({ kind: "resolution", ...resolution });
      return false;
    }
  }, []);

  const invalidateProposal = useCallback(async (
    proposal: DeferredLiveProposal,
    reason: ReviewInvalidationReason,
  ): Promise<boolean> => {
    const bridge = getNautiloApp();
    if (!bridge?.session?.invalidateProposal) return false;
    try {
      await bridge.session.invalidateProposal({
        proposalSessionToken: proposal.sessionToken,
        proposalId: proposal.proposal.proposalId,
        documentVersion: proposal.documentVersion,
        reason,
      });
      return true;
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The review could not be closed. Keep this screen open and try again.",
      );
      return false;
    }
  }, []);

  const invalidateCurrentReview = useCallback(async (reason: ReviewInvalidationReason): Promise<boolean> => {
    const state = suggestionControllerRef.current?.getState();
    const pending = state?.kind === "pending"
      ? state
      : state?.kind === "accepting"
        ? state.pending
        : null;
    if (!pending || reviewInvalidationInFlightRef.current === pending.proposalId) return false;
    reviewInvalidationInFlightRef.current = pending.proposalId;
    const invalidation: PendingReviewInvalidation = {
      kind: "invalidation",
      proposal: {
        proposal: {
          proposalId: pending.proposalId,
          sessionId: "",
          documentVersion: pending.documentVersion,
          operations: [],
        },
        sessionToken: pending.request.sessionToken,
        documentVersion: pending.documentVersion,
      },
      reason,
    };
    // Hide the now-stale detached review before the network call. A failed
    // invalidation keeps this exact captured-token request visible for retry;
    // it must never leave accept controls over a remotely changed document.
    if (reason !== "no_effective_change") {
      suggestionControllerRef.current?.invalidate(reason);
    } else {
      suggestionControllerRef.current?.rejectAll();
    }
    suggestionControllerRef.current?.dismiss();
    setActiveSuggestionChangeId(null);
    try {
      const closed = await invalidateProposal(invalidation.proposal, reason);
      if (!closed) {
        setPendingTaskResolution(invalidation);
        setErrorMessage(
          "The document changed, so this review was hidden. Retry closing it to update the background task.",
        );
        return false;
      }
      setPendingTaskResolution((pendingResolution) =>
        pendingResolution?.kind === "invalidation" &&
        pendingResolution.proposal.proposal.proposalId === pending.proposalId
          ? null
          : pendingResolution,
      );
      return true;
    } finally {
      reviewInvalidationInFlightRef.current = null;
    }
  }, [invalidateProposal]);

  const retainInvalidationForRetry = useCallback((
    proposal: DeferredLiveProposal,
    reason: ReviewInvalidationReason,
  ): void => {
    setPendingTaskResolution({ kind: "invalidation", proposal, reason });
    setErrorMessage(
      "This review is no longer current. Retry closing it to update the background task.",
    );
  }, []);

  const retryPendingTaskResolution = useCallback(async (): Promise<void> => {
    const pending = pendingTaskResolution;
    if (!pending) return;
    if (pending.kind === "resolution") {
      const confirmed = await notifyTaskResolution(pending);
      if (confirmed) {
        suggestionControllerRef.current?.dismiss();
        setErrorMessage(null);
      }
      return;
    }
    const closed = await invalidateProposal(pending.proposal, pending.reason);
    if (closed) {
      setPendingTaskResolution((current) =>
        current?.kind === "invalidation" &&
        current.proposal.proposal.proposalId === pending.proposal.proposal.proposalId
          ? null
          : current,
      );
      setErrorMessage(null);
    }
  }, [invalidateProposal, notifyTaskResolution, pendingTaskResolution]);

  const presentLiveProposal = useCallback((proposal: NautiloWriterProposal): void => {
    const capability = liveSessionRef.current;
    const currentVersion = liveDocumentVersionRef.current;
    const store = storeRef.current;
    const proposalVersion = proposalIngressVersion(proposal);
    const direct = proposalVersion && capability
      ? { proposal, sessionToken: capability.sessionToken, documentVersion: proposalVersion }
      : null;
    if (!capability || proposal.sessionId !== capability.sessionId) {
      if (direct) {
        void invalidateProposal(direct, "session_closed").then((closed) => {
          if (!closed) retainInvalidationForRetry(direct, "session_closed");
        });
      }
      return;
    }
    if (
      !currentVersion ||
      !proposalVersion ||
      !liveDocumentVersionEquals(proposalVersion, capability.documentVersion) ||
      !liveDocumentVersionEquals(proposalVersion, currentVersion) ||
      !store
    ) {
      if (direct) {
        void invalidateProposal(direct, "stale_version").then((closed) => {
          if (!closed) retainInvalidationForRetry(direct, "stale_version");
        });
      }
      return;
    }
    const deferred = { proposal, sessionToken: capability.sessionToken, documentVersion: proposalVersion } satisfies DeferredLiveProposal;
    if (store.hasUnsavedLocalEdits()) {
      deferredLiveProposalRef.current = deferred;
      setDeferredLiveProposal(deferred);
      return;
    }
    const next = suggestionControllerRef.current?.receive(
      { ...proposal, sessionToken: capability.sessionToken, documentVersion: proposalVersion },
      store.getDocument(),
      currentVersion,
    );
    if (next?.kind === "pending") {
      deferredLiveProposalRef.current = null;
      setDeferredLiveProposal(null);
      getNautiloApp()?.session?.acknowledgeProposal({
        proposalId: proposal.proposalId,
        documentVersion: proposalVersion,
      });
    } else if (direct) {
      void invalidateProposal(direct, "stale_version");
    }
  }, [invalidateProposal, retainInvalidationForRetry]);
  presentLiveProposalRef.current = presentLiveProposal;

  const saveDeferredLiveProposal = useCallback(async (): Promise<void> => {
    const store = storeRef.current;
    if (!store) return;
    const saved = await store.flush();
    if (saved) {
      const deferred = deferredLiveProposalRef.current;
      if (deferred) presentLiveProposalRef.current(deferred.proposal);
    }
  }, []);

  const persistPendingProposal = useCallback(async () => {
    const bridge = getNautiloApp();
    const pending = suggestionControllerRef.current?.getState();
    const acceptingVersion = liveDocumentVersionRef.current;
    const result = await persistAcceptedProposal({
      controller: suggestionControllerRef.current,
      store: storeRef.current,
      currentDocumentVersion: acceptingVersion,
      liveSession: liveSessionRef.current,
      bridge: bridge?.session ?? null,
    });
    if (result.kind === "local_persisted" || result.kind === "artifact_receipt_persisted") {
      baseSha256Ref.current = result.contentSha256;
      baseRevisionRef.current = result.documentVersion.kind === "artifact_revision"
        ? result.documentVersion.revision
        : null;
      liveDocumentVersionRef.current = result.documentVersion;
      const liveSession = liveSessionRef.current;
      if (
        liveSession &&
        acceptingVersion &&
        (
          liveDocumentVersionEquals(liveSession.documentVersion, acceptingVersion) ||
          liveDocumentVersionEquals(liveSession.documentVersion, result.documentVersion)
        )
      ) {
        liveSessionRef.current = {
          ...liveSession,
          documentVersion: result.documentVersion,
        };
      }
      dirtyRef.current = false;
      setSaveStatus("saved");
      publishContextRef.current(false);
    }
    if (result.kind !== "not_persisted") {
      // Paint the receipt-confirmed document before Task finalization. The
      // incoming event path below rejects duplicate or older versions, so a
      // delayed notification cannot replace this accepted postimage.
      rerenderFromStore();
      let confirmed = true;
      const acceptanceRouteAlreadySettledReview =
        result.kind === "local_persisted" || result.kind === "artifact_receipt_persisted";
      if (pending?.kind === "pending" && !acceptanceRouteAlreadySettledReview) {
        confirmed = await notifyTaskResolution({
          proposalId: pending.proposalId,
          documentVersion: pending.documentVersion,
          outcome: "accepted",
        });
        if (!confirmed) {
          setErrorMessage("Changes were saved, but the background task completion could not be confirmed.");
        }
      }
      if (confirmed) suggestionControllerRef.current?.dismiss();
    }
    return result.kind !== "not_persisted";
  }, [notifyTaskResolution, rerenderFromStore]);

  const acceptSuggestion = useCallback(async (all: boolean, changeId?: string) => {
    const controller = suggestionControllerRef.current;
    if (!all) {
      if (changeId) {
        const result = controller?.acceptChangeAndSelectNext(changeId);
        setActiveSuggestionChangeId(result?.nextChangeId ?? null);
        if (
          result?.state.kind === "pending" &&
          result.state.changes.length === 0 &&
          result.state.acceptedOperationIndexes.length > 0
        ) {
          await persistPendingProposal();
        }
      }
      return;
    }
    await persistPendingProposal();
  }, [persistPendingProposal]);

  const rejectSuggestion = useCallback(async (all: boolean, changeId?: string) => {
    const controller = suggestionControllerRef.current;
    const pending = controller?.getState();
    let rejectedAll = false;
    if (all) {
      controller?.rejectAll();
      rejectedAll = true;
    }
    else if (changeId) {
      const result = controller?.rejectChangeAndSelectNext(changeId);
      setActiveSuggestionChangeId(result?.nextChangeId ?? null);
      if (result?.state.kind === "completed") {
        rejectedAll = true;
      }
    }
    if (rejectedAll && pending?.kind === "pending") {
      const confirmed = await notifyTaskResolution({
          proposalId: pending.proposalId,
          documentVersion: pending.documentVersion,
          outcome: "rejected",
      });
      if (!confirmed) {
        setErrorMessage("The review was rejected, but the background task cancellation could not be confirmed.");
      } else {
        controller?.dismiss();
      }
    }
  }, [notifyTaskResolution]);

  const continueEditing = useCallback(async () => {
    const controller = suggestionControllerRef.current;
    const pending = controller?.getState();
    if (pending?.kind === "pending") {
      const confirmed = await notifyTaskResolution({
        proposalId: pending.proposalId,
        documentVersion: pending.documentVersion,
        outcome: "rejected",
      });
      if (!confirmed) {
        setErrorMessage("The review could not be closed. Keep it open and retry confirmation.");
        return;
      }
    }
    controller?.invalidate("human_changed");
    controller?.dismiss();
    setActiveSuggestionChangeId(null);
    rerenderFromStore();
    editorRef.current?.focus();
  }, [notifyTaskResolution, rerenderFromStore]);

  const closeNoEffectiveSuggestion = useCallback(() => {
    void invalidateCurrentReview("no_effective_change");
  }, [invalidateCurrentReview]);

  // P3.2 — publish a compact doc summary to the agent's activeMiniApp context.
  const publishContext = useCallback((dirty: boolean) => {
    const bridge = getNautiloApp();
    const store = storeRef.current;
    if (!bridge?.context || !store) return;
    try {
      const liveSession = liveSessionRef.current;
      bridge.context.set(
        buildContextEnvelope({
          documentPath: documentPathRef.current,
          document: store.getDocument() as unknown as WafflebaseDocumentPayload,
          dirty,
          ...(selectionRef.current !== undefined ? { selection: selectionRef.current } : {}),
          ...(liveSession
            ? {
                liveSession: {
                  sessionToken: liveSession.sessionToken,
                  sessionId: liveSession.sessionId,
                  documentVersion: liveSession.documentVersion,
                },
              }
            : {}),
        }),
      );
    } catch {
      /* best-effort context publish */
    }
  }, []);
  // Stable ref to the latest publishContext so the (deps: []) mountEditor cursor
  // subscription can call it without capturing a stale closure.
  const publishContextRef = useRef(publishContext);
  publishContextRef.current = publishContext;

  const publishHumanEdit = useCallback(
    (state: "clean" | "dirty" | "saving" | "conflict") => {
      const bridge = getNautiloApp();
      if (!bridge?.humanEdit || !storeRef.current) return;
      // Writer containers can be document-sized. Human-edit leases are
      // advisory presence, never a second save path, so publish state only.
      bridge.humanEdit.set({ state });
    },
    [],
  );

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const bridge = getNautiloApp();
    const unsubscribeLiveSession = bridge?.session?.onChange((capability) => {
      const currentVersion = liveDocumentVersionRef.current;
      if (
        currentVersion?.kind === "artifact_revision" &&
        capability.documentVersion.kind === "artifact_revision" &&
        capability.documentVersion.revision < currentVersion.revision
      ) return;
      const pending = suggestionControllerRef.current?.getState();
      if (pending?.kind === "pending" && (
        pending.request.sessionToken !== capability.sessionToken ||
        !liveDocumentVersionEquals(pending.documentVersion, capability.documentVersion)
      )) {
        void invalidateCurrentReview("stale_version");
      }
      liveSessionRef.current = capability;
      liveDocumentVersionRef.current = capability.documentVersion;
      publishContextRef.current(dirtyRef.current);
    });
    const unsubscribeSessionClosed = bridge?.session?.onClosed?.((event) => {
      const capability = liveSessionRef.current;
      if (capability && event.sessionId === capability.sessionId) {
        suggestionControllerRef.current?.invalidate("session_closed");
        if (deferredLiveProposalRef.current) {
          deferredLiveProposalRef.current = null;
          setDeferredLiveProposal(null);
          setErrorMessage("The review session closed before the suggested changes could be shown.");
        }
        liveSessionRef.current = undefined;
        publishContextRef.current(dirtyRef.current);
      }
    });
    const unsubscribeProposal = bridge?.session?.onProposal((proposal) => {
      presentLiveProposalRef.current(proposal);
    });

    const buildStore = (initialContainer: string, forBridge: NautiloAppBridge | null): NautiloDocStore =>
      new NautiloDocStore(initialContainer, {
        createStore: (doc) => new MemDocStore(doc),
        // First local mutation after a clean state → mark dirty + tell the agent
        // once (guarded so we don't rebuild the summary on every keystroke).
        onLocalChange: () => {
          void invalidateCurrentReview("human_changed");
          publishHumanEdit("dirty");
          if (dirtyRef.current) return;
          dirtyRef.current = true;
          publishContext(true);
        },
        onPersisted: ({ dirty }) => {
          dirtyRef.current = dirty;
          setSaveStatus(dirty ? "unsaved" : "saved");
          publishContext(dirty);
          publishHumanEdit(dirty ? "dirty" : "clean");
          if (!dirty && deferredLiveProposalRef.current) {
            presentLiveProposalRef.current(deferredLiveProposalRef.current.proposal);
          }
        },
        writePatch: async ({ container }) => {
          if (!forBridge) return true;
          setSaveStatus("saving");
          publishHumanEdit("saving");
          try {
            const result = await forBridge.document.write(
              { content: container },
              { baseSha256: baseSha256Ref.current, baseRevision: baseRevisionRef.current },
            );
            if (result.kind === "saved") {
              baseSha256Ref.current = result.sha256 ?? baseSha256Ref.current;
              baseRevisionRef.current = result.revision ?? baseRevisionRef.current;
              if (result.path) {
                documentPathRef.current = result.path;
              }
              return true;
            }
            // A real base-sha/revision conflict = someone else changed the doc.
            if (result.kind === "conflict") {
              setSaveStatus("conflict");
              publishHumanEdit("conflict");
              return false;
            }
            if (result.kind === "error") {
              // An honest write error (e.g. the document/image exceeds the size
              // limit) — surface the server's reason instead of a phantom
              // "changed elsewhere" conflict (M205 follow-up).
              setSaveStatus("failed");
              setErrorMessage(result.message || "Failed to save document.");
              publishHumanEdit("dirty");
              return false;
            }
            setSaveStatus("failed");
            setErrorMessage("Failed to save document.");
            publishHumanEdit("dirty");
            return false;
          } catch (err) {
            setSaveStatus("failed");
            setErrorMessage(err instanceof Error ? err.message : "Failed to save document.");
            publishHumanEdit("dirty");
            return false;
          }
        },
      });

    // No bridge bound → editable blank doc that will not persist.
    if (!bridge) {
      const store = buildStore(createEmptyWriterHtml(), null);
      void store.initBase().then(() => {
        mountEditor(store);
        setPhase({ kind: "no-document" });
      });
      return;
    }

    const applyEnvelope = async (envelope: NautiloDocumentEnvelope) => {
      documentPathRef.current = envelope.path;
      baseSha256Ref.current = envelope.baseSha256;
      baseRevisionRef.current = envelope.baseRevision;
      liveDocumentVersionRef.current = envelopeDocumentVersion(envelope);
      const container = envelope.content.trim().length === 0 ? createEmptyWriterHtml() : envelope.content;
      const store = buildStore(container, bridge);
      await store.initBase();
      mountEditor(store);
      setSaveStatus("saved");
      setPhase({ kind: "ready" });
      publishContext(false);
      publishHumanEdit("clean");
    };

    const reload = async () => {
      const store = storeRef.current;
      if (!store) return;
      const latest = parseEnvelope(await bridge.document.read());
      if (!latest) {
        setPhase({ kind: "invalid", message: "Unexpected document envelope from host." });
        return;
      }
      const incomingVersion = envelopeDocumentVersion(latest);
      if (
        incomingVersion &&
        !shouldApplyIncomingDocumentVersion(liveDocumentVersionRef.current, incomingVersion)
      ) return;
      const res = store.applyRemotePatch(
        latest.content.trim().length === 0 ? createEmptyWriterHtml() : latest.content,
      );
      if (!res.ok) {
        setSaveStatus("conflict");
        publishHumanEdit("conflict");
        return;
      }
      // Do not advance write-base refs until the rebase has actually
      // succeeded. A failed overlap must leave Keep mine on the original CAS
      // base, where it can only conflict/retry — never overwrite the remote.
      documentPathRef.current = latest.path;
      baseSha256Ref.current = latest.baseSha256;
      baseRevisionRef.current = latest.baseRevision;
      liveDocumentVersionRef.current = incomingVersion;
      rerenderFromStore();
      const nextState = writerRemotePostimageState(res.rebased);
      dirtyRef.current = nextState.dirty;
      setSaveStatus(nextState.saveStatus);
      publishContext(nextState.dirty);
      publishHumanEdit(nextState.dirty ? "dirty" : "clean");
      setErrorMessage(null);
    };

    const unsubscribe = bridge.document.onChange?.((event) => {
      void (async () => {
        const store = storeRef.current;
        if (!store) return;
        if (event.type === "deleted") {
          setPhase({ kind: "invalid", message: "Document was deleted." });
          return;
        }
        if (isPatchAppliedDocumentChange(event)) {
          const incomingVersion: LiveDocumentVersion = typeof event.revision === "number"
            ? { kind: "artifact_revision", revision: event.revision }
            : { kind: "local_sha", sha256: event.sha256 };
          if (!shouldApplyIncomingDocumentVersion(liveDocumentVersionRef.current, incomingVersion)) return;
          if (event.path) {
            documentPathRef.current = event.path;
          }
          if (suggestionControllerRef.current?.getState().kind === "pending") {
            void invalidateCurrentReview("remote_changed");
          }
          const res = store.applyRemotePatch(event.envelope.content);
          if (!res.ok) {
            setSaveStatus("conflict");
            publishHumanEdit("conflict");
            return;
          }
          baseSha256Ref.current = event.sha256;
          baseRevisionRef.current = event.revision;
          liveDocumentVersionRef.current = incomingVersion;
          rerenderFromStore();
          // An agent postimage can exactly equal a still-debounced human
          // draft. That is now persisted truth, so clear the agent-facing
          // dirty/lease publication rather than leaving a phantom edit.
          const nextState = writerRemotePostimageState(res.rebased);
          dirtyRef.current = nextState.dirty;
          setSaveStatus(nextState.saveStatus);
          publishContext(nextState.dirty);
          publishHumanEdit(nextState.dirty ? "dirty" : "clean");
          return;
        }
        if (event.type === "changed" || event.type === "renamed") {
          if (suggestionControllerRef.current?.getState().kind === "pending") {
            void invalidateCurrentReview("remote_changed");
          }
          await reload();
        }
      })();
    });

    void (async () => {
      try {
        const envelope = parseEnvelope(await bridge.document.read());
        if (!envelope) {
          setPhase({ kind: "invalid", message: "Unexpected document envelope from host." });
          return;
        }
        await applyEnvelope(envelope);
      } catch (err) {
        if (isNoDocumentError(err)) {
          const store = buildStore(createEmptyWriterHtml(), bridge);
          await store.initBase();
          mountEditor(store);
          setPhase({ kind: "no-document" });
          return;
        }
        setPhase({ kind: "invalid", message: err instanceof Error ? err.message : "Failed to load document." });
      }
    })();

    return () => {
      unsubscribe?.();
      unsubscribeLiveSession?.();
      unsubscribeSessionClosed?.();
      unsubscribeProposal?.();
      cursorUnsubRef.current?.();
      cursorUnsubRef.current = null;
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      void storeRef.current?.flush();
    };
  }, [invalidateCurrentReview, mountEditor, rerenderFromStore, publishContext, publishHumanEdit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void storeRef.current?.flush();
      }
    };
    const onBlur = () => void storeRef.current?.flush();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const banner = (
    <>
      {phase.kind === "no-document" ? (
        <div className="writer-banner writer-banner--info">
          No document is open. Editing a blank template; changes will not persist until a file is bound.
        </div>
      ) : null}
      {phase.kind === "invalid" ? (
        <div className="writer-banner writer-banner--error">{phase.message}</div>
      ) : null}
      {deferredLiveProposal ? (
        <div className="writer-banner writer-banner--info">
          <span>Save your edits before reviewing the suggested changes.</span>
          <div className="writer-banner__actions">
            <button
              type="button"
              disabled={saveStatus === "saving"}
              onClick={() => { void saveDeferredLiveProposal(); }}
            >
              Save and review
            </button>
          </div>
        </div>
      ) : null}
      {(saveStatus === "failed" || pendingTaskResolution) && errorMessage ? (
        <div className="writer-banner writer-banner--error">{errorMessage}</div>
      ) : null}
      {pendingTaskResolution?.kind === "resolution" ? (
        <div className="writer-banner writer-banner--info">
          <span>The document decision is saved, but the background task still needs confirmation.</span>
          <div className="writer-banner__actions">
            <button
              type="button"
              onClick={() => { void retryPendingTaskResolution(); }}
            >
              Retry task confirmation
            </button>
          </div>
        </div>
      ) : null}
      {pendingTaskResolution?.kind === "invalidation" ? (
        <div className="writer-banner writer-banner--error">
          <span>The document changed, so its stale review is hidden. The background task still needs that review closed.</span>
          <div className="writer-banner__actions">
            <button
              type="button"
              onClick={() => { void retryPendingTaskResolution(); }}
            >
              Retry closing review
            </button>
          </div>
        </div>
      ) : null}
      {saveStatus === "conflict" ? (
        <div className="writer-banner writer-banner--conflict">
          <span>This document changed elsewhere.</span>
          <div className="writer-banner__actions">
            <button
              type="button"
              onClick={() => {
                const bridge = getNautiloApp();
                const store = storeRef.current;
                if (!bridge || !store) return;
                void (async () => {
                  const latest = parseEnvelope(await bridge.document.read());
                  if (!latest) return;
                  // Reload is an explicit human discard action. It must never
                  // invoke merge/rebase against the conflicted draft.
                  const res = store.installAcceptedContent(
                    latest.content.trim().length === 0 ? createEmptyWriterHtml() : latest.content,
                    latest.baseSha256 ?? "",
                  );
                  if (res.ok) {
                    documentPathRef.current = latest.path;
                    baseSha256Ref.current = latest.baseSha256;
                    baseRevisionRef.current = latest.baseRevision;
                    liveDocumentVersionRef.current = envelopeDocumentVersion(latest);
                    dirtyRef.current = false;
                    rerenderFromStore();
                    setSaveStatus("saved");
                    setErrorMessage(null);
                    publishContext(false);
                    publishHumanEdit("clean");
                  }
                })();
              }}
            >
              Reload latest
            </button>
            <button type="button" onClick={() => void storeRef.current?.flush()}>
              Keep mine
            </button>
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <WriterDocSurface
      editor={editor}
      canvasRef={(el) => { canvasRef.current = el; }}
      saveStatus={saveStatus}
      banner={banner}
      suggestionState={suggestionState}
      activeSuggestionChangeId={activeSuggestionChangeId}
      onActiveSuggestionChange={setActiveSuggestionChangeId}
      onAcceptSuggestion={(all, changeId) => { void acceptSuggestion(all, changeId); }}
      onRejectSuggestion={(all, changeId) => { void rejectSuggestion(all, changeId); }}
      onNoEffectiveSuggestion={closeNoEffectiveSuggestion}
      onContinueEditing={() => { void continueEditing(); }}
      onDismissSuggestion={() => suggestionControllerRef.current?.dismiss()}
      spellPreference={spellPreference}
      onSpellPreferenceChange={updateSpellPreference}
    />
  );
}
