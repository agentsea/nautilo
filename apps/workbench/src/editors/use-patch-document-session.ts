import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentPatchConflictError } from "@nautilo/api-client/browser";
import {
  applyAnchoredTextPatch,
  deriveExactAnchoredTextPatch,
  mergeTextHumanPriority,
  type AnchoredTextPatch,
  type DocumentPatchEvent,
} from "@nautilo/types";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { apiClient } from "../lib/api";
import { desktopAPI } from "../lib/desktop";
import { fsDirectoryChangeAffectsFile } from "../lib/fs-directory-changed";
import type { LoadEditableTextResult } from "./editor-io";
import { useWorkspaceArtifactEventHub } from "../artifacts/workspace-artifacts-provider";
import {
  isWorkspaceArtifactCommittedMutation,
  localFileEditorSavePatchEvent,
  workspaceArtifactEventClientMutationId,
  workspaceArtifactEventId,
  workspaceEditorSavePatchEvent,
  type WorkspaceEditorSavePatchEvent,
} from "../artifacts/workspace-document-mutation-events";
import { saveEditableText, sha256HexForText } from "./editor-io";
import { isLocalFsSaveSha, registerLocalFsSaveSha } from "./local-fs-save-shas";
import {
  consumeLocalArtifactSaveMutation,
  registerLocalArtifactSaveMutation,
  settleLocalArtifactSaveMutation,
} from "./local-artifact-save-mutations";
import { saveConflictCopy } from "./editor-conflict-copy";
import {
  AUTOSAVE_DEBOUNCE_MS,
  getAutosaveEnabled,
  setAutosaveEnabled,
} from "./use-doc-editor";
import { useHumanEditLease } from "./use-human-edit-lease";

export const CHANGED_EVENT_RELOAD_DELAY_MS = 175;

export type PatchEditorStatus =
  | "idle"
  | "patching"
  | "saved"
  | "failed"
  | "conflict"
  | "unsaved"
  | "rebasing"
  | "resyncing"
  | "offline-queued";

export type PatchEditorConflict = {
  latestContent: string | null;
  currentSha256: string | null;
};

export type UsePatchDocumentSessionOptions = {
  file: OpenFileTarget;
  initialContent: string;
  baseSha256: string;
  baseRevision: number | null;
  loadLatest?: () => Promise<LoadEditableTextResult>;
};

type RemotePatchEvent = Pick<
  DocumentPatchEvent,
  "patchId" | "sha256" | "previousSha256" | "patch"
> & { revision: number | null; previousRevision: number | null };

function newClientMutationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `editor-patch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `patch-req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function applyPatchToText(text: string, patch: AnchoredTextPatch): string | null {
  const result = applyAnchoredTextPatch(text, patch);
  return result.ok ? result.text : null;
}

function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("failed to fetch") ||
      msg.includes("network") ||
      msg.includes("load failed")
    );
  }
  return false;
}

function shouldQueueOffline(err: unknown): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false && isNetworkFailure(err);
}

export function usePatchDocumentSession({
  file,
  initialContent,
  baseSha256,
  baseRevision,
  loadLatest,
}: UsePatchDocumentSessionOptions) {
  const subscribeWorkspaceArtifactEvents = useWorkspaceArtifactEventHub();
  const [draft, setDraft] = useState(initialContent);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<PatchEditorStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [autosaveEnabled, setAutosaveEnabledState] = useState(getAutosaveEnabled);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PatchEditorConflict | null>(null);
  const [conflictLoadError, setConflictLoadError] = useState<string | null>(null);

  const draftRef = useRef(initialContent);
  const baseContentRef = useRef(initialContent);
  const baseShaRef = useRef(baseSha256);
  const baseRevisionRef = useRef(baseRevision);
  const localIdentityRef = useRef<{
    kind: "local_file";
    relayId: string;
    canonicalPath: string;
  } | undefined>(undefined);
  const autosaveEnabledRef = useRef(autosaveEnabled);
  const conflictRef = useRef<PatchEditorConflict | null>(null);
  const firstCheckpointPendingRef = useRef(true);
  const patchGenerationRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changedReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patchInFlightRef = useRef(false);
  const patchQueuedRef = useRef(false);
  const runQueuedPatchRef = useRef<(checkpoint: boolean) => Promise<boolean>>(() => Promise.resolve(false));
  const ownMutationIdsRef = useRef(new Set<string>());
  const conflictLatestRef = useRef<{
    content: string;
    sha256: string;
    revision: number | null;
  } | null>(null);
  const offlineQueuedRef = useRef(false);

  // Advisory human-edit coordination runs independently from the established
  // save path. It observes retained editor truth in the background and never
  // awaits or alters a local/Workspace write.
  useHumanEditLease({
    file,
    baseContent: baseContentRef.current,
    draft,
    dirty,
    status,
  });

  useEffect(() => {
    autosaveEnabledRef.current = autosaveEnabled;
  }, [autosaveEnabled]);

  useEffect(() => {
    if (file.kind !== "fs" || !desktopAPI) return;
    let cancelled = false;
    void desktopAPI.fs.stat(file.path).then((stat) => {
      if (!cancelled) localIdentityRef.current = stat.documentIdentity ?? undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  useEffect(() => {
    draftRef.current = initialContent;
    baseContentRef.current = initialContent;
    baseShaRef.current = baseSha256;
    baseRevisionRef.current = baseRevision;
    localIdentityRef.current = undefined;
    firstCheckpointPendingRef.current = true;
    conflictLatestRef.current = null;
    conflictRef.current = null;
    patchInFlightRef.current = false;
    patchQueuedRef.current = false;
    ownMutationIdsRef.current.clear();
    offlineQueuedRef.current = false;
    setDraft(initialContent);
    setDirty(false);
    setStatus("idle");
    setErrorMessage(null);
    setConflict(null);
    setConflictLoadError(null);
    setLastSavedAt(null);
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (changedReloadTimerRef.current !== null) {
      clearTimeout(changedReloadTimerRef.current);
      changedReloadTimerRef.current = null;
    }
  }, [initialContent, baseSha256, baseRevision]);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const cancelChangedReload = useCallback(() => {
    if (changedReloadTimerRef.current !== null) {
      clearTimeout(changedReloadTimerRef.current);
      changedReloadTimerRef.current = null;
    }
  }, []);

  const syncDirty = useCallback(() => {
    const isDirty = draftRef.current !== baseContentRef.current;
    setDirty(isDirty);
    return isDirty;
  }, []);

  const enterConflict = useCallback(
    async (
      currentSha256: string | null,
      generation: number,
      loadedLatest?: Extract<LoadEditableTextResult, { kind: "ready" }>,
    ) => {
      if (generation !== patchGenerationRef.current) return;
      const nextConflict: PatchEditorConflict = {
        latestContent: null,
        currentSha256,
      };
      conflictRef.current = nextConflict;
      setConflictLoadError(null);
      setStatus("conflict");
      setConflict(nextConflict);
      conflictLatestRef.current = null;

      let latest: LoadEditableTextResult;
      try {
        latest = loadedLatest ?? (loadLatest
          ? await loadLatest()
          : { kind: "error", message: "Could not reload document." });
      } catch (err) {
        latest = { kind: "error", message: err instanceof Error ? err.message : "Could not reload document." };
      }
      if (generation !== patchGenerationRef.current) return;
      if (latest.kind === "ready") {
        conflictLatestRef.current = {
          content: latest.content,
          sha256: latest.baseSha256,
          revision: latest.baseRevision,
        };
        const resolvedConflict = {
          latestContent: latest.content,
          currentSha256,
        };
        conflictRef.current = resolvedConflict;
        setConflict(resolvedConflict);
      } else {
        setConflictLoadError(latest.kind === "error" ? latest.message : "Latest version is too large to edit.");
      }
    },
    [loadLatest],
  );

  const tryRebaseDraftOntoLatest = useCallback(
    async (latest: Extract<LoadEditableTextResult, { kind: "ready" }>, generation: number) => {
      const localBase = baseContentRef.current;
      const localDraft = draftRef.current;

      if (localDraft === localBase) {
        baseContentRef.current = latest.content;
        baseShaRef.current = latest.baseSha256;
        baseRevisionRef.current = latest.baseRevision;
        draftRef.current = latest.content;
        setDraft(latest.content);
        syncDirty();
        setStatus("idle");
        return true;
      }

      const merge = mergeTextHumanPriority({
        base: localBase,
        humanDraft: localDraft,
        agentPostimage: latest.content,
      });

      if (merge.ok) {
        baseContentRef.current = latest.content;
        baseShaRef.current = latest.baseSha256;
        baseRevisionRef.current = latest.baseRevision;
        draftRef.current = merge.text;
        setDraft(merge.text);
        conflictRef.current = null;
        setConflict(null);
        setConflictLoadError(null);
        conflictLatestRef.current = null;
        syncDirty();
        if (generation !== patchGenerationRef.current) return true;
        if (draftRef.current === baseContentRef.current) {
          setStatus("idle");
        } else {
          setStatus("unsaved");
        }
        return true;
      }

      await enterConflict(latest.baseSha256, generation, latest);
      return false;
    },
    [enterConflict, syncDirty],
  );

  const runFullResync = useCallback(
    async (generation: number) => {
      if (!loadLatest) return;
      setStatus("resyncing");
      const latest = await loadLatest();
      if (generation !== patchGenerationRef.current) return;
      if (latest.kind !== "ready") {
        setStatus("failed");
        setErrorMessage(latest.kind === "error" ? latest.message : "Could not reload document.");
        return;
      }
      localIdentityRef.current = latest.localIdentity;
      await tryRebaseDraftOntoLatest(latest, generation);
    },
    [loadLatest, tryRebaseDraftOntoLatest],
  );

  const applyRemotePatchEvent = useCallback(
    async (
      event: RemotePatchEvent | WorkspaceEditorSavePatchEvent,
      generation: number,
    ): Promise<boolean> => {
      const capturedBaseContent = baseContentRef.current;
      const capturedBaseSha = baseShaRef.current;
      const capturedBaseRevision = baseRevisionRef.current;
      const capturedDraft = draftRef.current;
      if (
        capturedBaseSha !== event.previousSha256 ||
        (event.previousRevision !== null &&
          capturedBaseRevision !== event.previousRevision)
      ) {
        await runFullResync(generation);
        return false;
      }
      const patchedBase = applyPatchToText(capturedBaseContent, event.patch);
      if (patchedBase === null) {
        await runFullResync(generation);
        return false;
      }
      const mergedDraft = mergeTextHumanPriority({
        base: capturedBaseContent,
        humanDraft: capturedDraft,
        agentPostimage: patchedBase,
      });
      if (!mergedDraft.ok) {
        await runFullResync(generation);
        return false;
      }
      if (await sha256HexForText(patchedBase) !== event.sha256) {
        await runFullResync(generation);
        return false;
      }
      if (
        generation !== patchGenerationRef.current ||
        baseContentRef.current !== capturedBaseContent ||
        baseShaRef.current !== capturedBaseSha ||
        baseRevisionRef.current !== capturedBaseRevision ||
        draftRef.current !== capturedDraft
      ) {
        await runFullResync(patchGenerationRef.current);
        return false;
      }

      baseContentRef.current = patchedBase;
      baseShaRef.current = event.sha256;
      baseRevisionRef.current = event.revision;
      draftRef.current = mergedDraft.text;
      setDraft(mergedDraft.text);

      conflictRef.current = null;
      setConflict(null);
      setConflictLoadError(null);
      conflictLatestRef.current = null;
      setErrorMessage(null);

      const isDirty = syncDirty();
      if (!isDirty) {
        setStatus("saved");
        setLastSavedAt(new Date());
      } else if (conflictRef.current === null) {
        setStatus(autosaveEnabledRef.current ? "unsaved" : "unsaved");
      }
      return true;
    },
    [runFullResync, syncDirty],
  );

  const scheduleChangedReload = useCallback(
    () => {
      cancelChangedReload();
      changedReloadTimerRef.current = setTimeout(() => {
        changedReloadTimerRef.current = null;
        const generation = patchGenerationRef.current;
        void runFullResync(generation);
      }, CHANGED_EVENT_RELOAD_DELAY_MS);
    },
    [cancelChangedReload, runFullResync],
  );

  const handlePatchAppliedAck = useCallback(
    (
      sentBase: string,
      sentDraft: string,
      patch: AnchoredTextPatch,
      response: { sha256: string; revision: number | null; patchId?: string },
      generation: number,
    ) => {
      const newBase = applyPatchToText(sentBase, patch) ?? sentDraft;
      baseContentRef.current = newBase;
      baseShaRef.current = response.sha256;
      baseRevisionRef.current = response.revision;

      if (draftRef.current === sentDraft) {
        draftRef.current = newBase;
        if (newBase !== sentDraft) {
          setDraft(newBase);
        }
        setDirty(false);
        setStatus("saved");
        setLastSavedAt(new Date());
        setErrorMessage(null);
        setConflict(null);
        setConflictLoadError(null);
        conflictRef.current = null;
        conflictLatestRef.current = null;
        offlineQueuedRef.current = false;
        return;
      }

      syncDirty();
      if (generation === patchGenerationRef.current) {
        setStatus("unsaved");
      }
    },
    [syncDirty],
  );

  const finishPatchQueue = useCallback(
    (runNext: (checkpoint: boolean) => Promise<boolean>) => {
      patchInFlightRef.current = false;
      if (patchQueuedRef.current) {
        patchQueuedRef.current = false;
        const checkpointNext = firstCheckpointPendingRef.current;
        if (checkpointNext) {
          firstCheckpointPendingRef.current = false;
        }
        void runNext(checkpointNext);
      }
    },
    [],
  );

  const runSnapshotSave = useCallback(
    async (force: boolean, checkpoint: boolean) => {
      if (patchInFlightRef.current) {
        patchQueuedRef.current = true;
        return false;
      }
      patchInFlightRef.current = true;
      const generation = ++patchGenerationRef.current;
      const content = draftRef.current;
      const base = force
        ? { sha256: null, revision: null }
        : { sha256: baseShaRef.current, revision: baseRevisionRef.current };
      setStatus("patching");
      setErrorMessage(null);

      const clientMutationId = newClientMutationId();
      ownMutationIdsRef.current.add(clientMutationId);
      registerLocalArtifactSaveMutation(clientMutationId);
      let saved = false;
      try {
        if (file.kind === "fs") {
          registerLocalFsSaveSha(file.path, await sha256HexForText(content));
        }
        const result = await saveEditableText(file, content, base, checkpoint, { clientMutationId });
        saved = result.kind === "saved";
        settleLocalArtifactSaveMutation(clientMutationId, saved);
        if (!saved) ownMutationIdsRef.current.delete(clientMutationId);
        if (generation !== patchGenerationRef.current) return false;

        if (result.kind === "saved") {
          // The receipt acknowledges only the sent bytes. Typing and paste
          // events during this write still belong to the retained human draft.
          baseContentRef.current = content;
          baseShaRef.current = result.newSha256;
          if (result.revision !== undefined) baseRevisionRef.current = result.revision;
          conflictLatestRef.current = null;
          conflictRef.current = null;
          setConflict(null);
          setConflictLoadError(null);
          setErrorMessage(null);
          offlineQueuedRef.current = false;
          const isDirty = syncDirty();
          setStatus(isDirty ? "unsaved" : "saved");
          setLastSavedAt(new Date());
          if (isDirty && autosaveEnabledRef.current) patchQueuedRef.current = true;
          return !isDirty;
        }

        if (result.kind === "conflict") {
          await enterConflict(result.currentSha256, generation);
          return false;
        }
        setStatus("failed");
        setErrorMessage(result.message);
        if (conflictRef.current?.latestContent === null) {
          setConflictLoadError("Latest version is unavailable. Retry loading it.");
        }
        return false;
      } finally {
        // A failed/uncertain snapshot must preserve the draft for explicit
        // recovery rather than replaying a queued mutation automatically.
        if (!saved || draftRef.current === baseContentRef.current) patchQueuedRef.current = false;
        finishPatchQueue((nextCheckpoint) => runQueuedPatchRef.current(nextCheckpoint));
      }
    },
    [enterConflict, file, finishPatchQueue, syncDirty],
  );

  const runFsPatch = useCallback(
    async (checkpoint: boolean) => {
      if (file.kind !== "fs" || conflictRef.current !== null) return false;

      if (patchInFlightRef.current) {
        patchQueuedRef.current = true;
        return false;
      }

      const api = desktopAPI;
      if (!api) {
        setStatus("failed");
        setErrorMessage("Desktop file bridge unavailable.");
        return false;
      }

      const generation = patchGenerationRef.current;
      const sentBase = baseContentRef.current;
      const sentDraft = draftRef.current;

      if (sentDraft === sentBase) {
        setDirty(false);
        if (conflictRef.current === null) {
          setStatus("idle");
        }
        return true;
      }

      const patch = deriveExactAnchoredTextPatch(sentBase, sentDraft);
      if (!patch) {
        if (sentBase.length === 0) {
          return runSnapshotSave(false, checkpoint);
        }
        setStatus("failed");
        setErrorMessage("Could not derive a patch for this edit.");
        return false;
      }

      patchInFlightRef.current = true;
      setStatus("patching");
      setErrorMessage(null);
      let clientMutationId: string | null = null;
      let committed = false;

      try {
        let currentContent: string;
        try {
          currentContent = await api.fs.readFile(file.path);
        } catch (err) {
          if (generation !== patchGenerationRef.current) return false;
          setStatus("failed");
          setErrorMessage(err instanceof Error ? err.message : "Could not read file.");
          return false;
        }

        const currentSha = await sha256HexForText(currentContent);
        let patchedText: string | null;

        if (currentSha === baseShaRef.current) {
          patchedText = applyPatchToText(sentBase, patch);
        } else {
          patchedText = applyPatchToText(currentContent, patch);
        }

        if (patchedText === null) {
          if (generation !== patchGenerationRef.current) return false;
          await enterConflict(currentSha, generation);
          return false;
        }

        const expectedSha = await sha256HexForText(patchedText);
        registerLocalFsSaveSha(file.path, expectedSha);

        clientMutationId = newClientMutationId();
        ownMutationIdsRef.current.add(clientMutationId);
        registerLocalArtifactSaveMutation(clientMutationId);
        const result = await api.fs.writeFile(file.path, patchedText, {
          baseSha256: currentSha,
          checkpoint,
          requestId: clientMutationId,
          clientMutationId,
          anchoredPatch: patch,
        });
        committed = result.ok;

        if (generation !== patchGenerationRef.current) return false;

        if (result.ok) {
          baseContentRef.current = patchedText;
          baseShaRef.current = result.sha256;
          baseRevisionRef.current = null;

          if (draftRef.current === sentDraft) {
            draftRef.current = patchedText;
            if (patchedText !== sentDraft) {
              setDraft(patchedText);
            }
            setDirty(false);
            setStatus("saved");
            setLastSavedAt(new Date());
            setErrorMessage(null);
            setConflict(null);
            setConflictLoadError(null);
            conflictRef.current = null;
            conflictLatestRef.current = null;
            offlineQueuedRef.current = false;
          } else {
            syncDirty();
            if (generation === patchGenerationRef.current) {
              setStatus("unsaved");
            }
          }
          return draftRef.current === baseContentRef.current;
        }

        if (result.code === "conflict") {
          setStatus("rebasing");
          if (loadLatest) {
            const latest = await loadLatest();
            if (generation !== patchGenerationRef.current) return false;
            if (latest.kind === "ready") {
              const rebased = await tryRebaseDraftOntoLatest(latest, generation);
              if (rebased && draftRef.current !== baseContentRef.current) {
                patchQueuedRef.current = true;
              }
              return rebased;
            }
          }
          await enterConflict(result.currentSha256 ?? null, generation);
          return false;
        }

        setStatus("failed");
        setErrorMessage(result.message ?? "Could not save file.");
        return false;
      } catch (err) {
        if (generation !== patchGenerationRef.current) return false;
        if (shouldQueueOffline(err)) {
          offlineQueuedRef.current = true;
          setStatus("offline-queued");
          setErrorMessage("Offline — changes queued locally.");
          syncDirty();
          return false;
        }
        setStatus("failed");
        setErrorMessage(err instanceof Error ? err.message : "Could not save file.");
        return false;
      } finally {
        if (clientMutationId && !committed) {
          ownMutationIdsRef.current.delete(clientMutationId);
        }
        if (clientMutationId) {
          settleLocalArtifactSaveMutation(clientMutationId, committed);
        }
        finishPatchQueue(runFsPatch);
      }
    },
    [
      enterConflict,
      file,
      finishPatchQueue,
      loadLatest,
      runSnapshotSave,
      syncDirty,
      tryRebaseDraftOntoLatest,
    ],
  );

  const runArtifactPatch = useCallback(
    async (checkpoint: boolean) => {
      if (file.kind !== "artifact" || conflictRef.current !== null) return false;

      if (patchInFlightRef.current) {
        patchQueuedRef.current = true;
        return false;
      }

      const generation = patchGenerationRef.current;
      const sentBase = baseContentRef.current;
      const sentDraft = draftRef.current;

      if (sentDraft === sentBase) {
        setDirty(false);
        if (conflictRef.current === null) {
          setStatus("idle");
        }
        return true;
      }

      const patch = deriveExactAnchoredTextPatch(sentBase, sentDraft);
      if (!patch) {
        if (sentBase.length === 0) {
          return runSnapshotSave(false, checkpoint);
        }
        setStatus("failed");
        setErrorMessage("Could not derive a patch for this edit.");
        return false;
      }

      patchInFlightRef.current = true;
      setStatus("patching");
      setErrorMessage(null);

      const clientMutationId = newClientMutationId();
      ownMutationIdsRef.current.add(clientMutationId);
      registerLocalArtifactSaveMutation(clientMutationId);

      try {
        const response = await apiClient.applyWorkspaceArtifactPatch(file.id, {
          requestId: newRequestId(),
          target: {
            kind: "artifact",
            artifactInternalId: file.id,
            path: file.path,
            ...(file.roomId !== undefined ? { roomId: file.roomId } : {}),
            mimeType: file.mimeType,
          },
          baseRevision: baseRevisionRef.current,
          baseSha256: baseShaRef.current,
          patch,
          clientMutationId,
          checkpoint,
          mimeType: file.mimeType,
        });
        settleLocalArtifactSaveMutation(clientMutationId, true);

        if (generation !== patchGenerationRef.current) return false;

        handlePatchAppliedAck(sentBase, sentDraft, patch, response, generation);
        return draftRef.current === baseContentRef.current;
      } catch (err) {
        settleLocalArtifactSaveMutation(clientMutationId, false);
        if (generation !== patchGenerationRef.current) return false;
        ownMutationIdsRef.current.delete(clientMutationId);

        if (err instanceof DocumentPatchConflictError) {
          setStatus("rebasing");
          if (loadLatest) {
            const latest = await loadLatest();
            if (generation !== patchGenerationRef.current) return false;
            if (latest.kind === "ready") {
              const rebased = await tryRebaseDraftOntoLatest(latest, generation);
              if (rebased && draftRef.current !== baseContentRef.current) {
                patchQueuedRef.current = true;
              }
              return rebased;
            }
          }
          const latestSha =
            err.rejection.kind === "anchor_not_found" ||
            err.rejection.kind === "anchor_ambiguous" ||
            err.rejection.kind === "stale_base_unrebaseable"
              ? err.rejection.latestSha256
              : null;
          await enterConflict(
            latestSha,
            generation,
          );
          return false;
        }

        if (shouldQueueOffline(err)) {
          offlineQueuedRef.current = true;
          setStatus("offline-queued");
          setErrorMessage("Offline — changes queued locally.");
          syncDirty();
          return false;
        }

        setStatus("failed");
        setErrorMessage(err instanceof Error ? err.message : "Patch failed.");
        return false;
      } finally {
        finishPatchQueue(runArtifactPatch);
      }
    },
    [enterConflict, file, finishPatchQueue, handlePatchAppliedAck, loadLatest, runSnapshotSave, syncDirty, tryRebaseDraftOntoLatest],
  );

  const runPatch = useCallback(
    async (checkpoint: boolean) => {
      if (file.kind === "fs") return runFsPatch(checkpoint);
      return runArtifactPatch(checkpoint);
    },
    [file.kind, runArtifactPatch, runFsPatch],
  );

  useEffect(() => {
    runQueuedPatchRef.current = runPatch;
  }, [runPatch]);

  const scheduleAutosave = useCallback(
    (checkpoint: boolean) => {
      clearDebounce();
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void runPatch(checkpoint);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [clearDebounce, runPatch],
  );

  const setDraftFromEditor = useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);

      const isDirty = next !== baseContentRef.current;
      setDirty(isDirty);

      if (!isDirty) {
        clearDebounce();
        if (conflictRef.current !== null) {
          setStatus("conflict");
        } else {
          setStatus("idle");
        }
        return;
      }

      if (conflictRef.current !== null) {
        clearDebounce();
        setStatus("conflict");
        return;
      }

      if (autosaveEnabledRef.current) {
        const checkpoint = firstCheckpointPendingRef.current;
        if (checkpoint) {
          firstCheckpointPendingRef.current = false;
        }
        scheduleAutosave(checkpoint);
        return;
      }

      clearDebounce();
      setStatus("unsaved");
    },
    [clearDebounce, scheduleAutosave],
  );

  const updateAutosaveEnabled = useCallback(
    (enabled: boolean) => {
      autosaveEnabledRef.current = enabled;
      setAutosaveEnabled(enabled);
      setAutosaveEnabledState(enabled);
      if (!enabled) {
        clearDebounce();
      }
    },
    [clearDebounce],
  );

  const saveNow = useCallback(
    ({ checkpoint }: { checkpoint: boolean }) => {
      clearDebounce();
      return runPatch(checkpoint);
    },
    [clearDebounce, runPatch],
  );

  const keepMine = useCallback(async () => {
    clearDebounce();
    if (patchInFlightRef.current) return false;
    if (file.kind === "fs") {
      if (!loadLatest) return false;
      const latest = await loadLatest();
      if (latest.kind !== "ready") {
        setStatus("failed");
        setErrorMessage(
          latest.kind === "error" ? latest.message : "Could not reload document.",
        );
        return false;
      }
      baseContentRef.current = latest.content;
      baseShaRef.current = latest.baseSha256;
      baseRevisionRef.current = latest.baseRevision;
      localIdentityRef.current = latest.localIdentity;
      // Preserve the human-confirmed draft, but CAS it against the exact
      // authoritative version just reread. A second race becomes a conflict.
      return await runSnapshotSave(false, true);
    }
    return runSnapshotSave(true, true);
  }, [clearDebounce, file.kind, loadLatest, runSnapshotSave]);

  const takeTheirs = useCallback(() => {
    if (patchInFlightRef.current) return;
    const latest = conflictLatestRef.current?.content ?? conflict?.latestContent;
    if (latest === null || latest === undefined) return;

    draftRef.current = latest;
    baseContentRef.current = latest;
    if (conflictLatestRef.current) {
      baseShaRef.current = conflictLatestRef.current.sha256;
      baseRevisionRef.current = conflictLatestRef.current.revision;
    }

    setDraft(latest);
    setDirty(false);
    conflictRef.current = null;
    setConflict(null);
    setConflictLoadError(null);
    conflictLatestRef.current = null;
    setStatus("idle");
    setErrorMessage(null);
  }, [conflict]);

  const markMergedAndSave = useCallback(() => {
    clearDebounce();
    if (patchInFlightRef.current) return false;
    const latest = conflictLatestRef.current;
    if (!latest) return false;
    baseContentRef.current = latest.content;
    baseShaRef.current = latest.sha256;
    baseRevisionRef.current = latest.revision;
    // Save the human's merged draft against the displayed latest version.
    // A later competing change must still fail compare-and-swap.
    return runSnapshotSave(false, true);
  }, [clearDebounce, runSnapshotSave]);

  const retryConflict = useCallback(async () => {
    const retained = conflictRef.current;
    if (!retained || patchInFlightRef.current) return;
    await enterConflict(retained.currentSha256, ++patchGenerationRef.current);
  }, [enterConflict]);

  const saveCopy = useCallback(async () => {
    const result = await saveConflictCopy(file, draftRef.current);
    if (result.kind === "saved") {
      setErrorMessage(null);
      return true;
    }
    setErrorMessage(result.message);
    return false;
  }, [file]);

  useEffect(() => {
    const onOnline = () => {
      if (!offlineQueuedRef.current) return;
      if (draftRef.current === baseContentRef.current) {
        offlineQueuedRef.current = false;
        setStatus("idle");
        setErrorMessage(null);
        return;
      }
      offlineQueuedRef.current = false;
      setErrorMessage(null);
      const checkpoint = firstCheckpointPendingRef.current;
      if (checkpoint) {
        firstCheckpointPendingRef.current = false;
      }
      void runPatch(checkpoint);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [runPatch]);

  useEffect(() => {
    const unsub = subscribeWorkspaceArtifactEvents(async (event) => {
        if (file.kind === "fs") {
          if (
            event.type !== "document.mutation.committed" ||
            event.mutation !== "update" ||
            event.after.identity.kind !== "local_file"
          ) return;
          const retainedIdentity = localIdentityRef.current;
          if (
            !retainedIdentity ||
            retainedIdentity.relayId !== event.after.identity.relayId ||
            retainedIdentity.canonicalPath !== event.after.identity.canonicalPath
          ) {
            await runFullResync(patchGenerationRef.current);
            return;
          }
          const ownId = workspaceArtifactEventClientMutationId(event);
          if (ownId && ownMutationIdsRef.current.delete(ownId)) return;
          const generation = patchGenerationRef.current;
          const patch = localFileEditorSavePatchEvent(event);
          if (patch) {
            cancelChangedReload();
            await applyRemotePatchEvent(patch, generation);
          } else {
            scheduleChangedReload();
          }
          return;
        }
        const artifactId = workspaceArtifactEventId(event);
        if (artifactId !== file.id) return;

        if (
          event.type === "deleted" ||
          (isWorkspaceArtifactCommittedMutation(event) && event.mutation === "delete")
        ) {
          setStatus("failed");
          setErrorMessage("This file was deleted.");
          return;
        }

        if (event.type === "renamed") {
          return;
        }

        const generation = patchGenerationRef.current;

        if (event.type === "document.mutation.committed") {
          const clientMutationId = workspaceArtifactEventClientMutationId(event);
          if (
            clientMutationId &&
            (ownMutationIdsRef.current.has(clientMutationId) ||
              consumeLocalArtifactSaveMutation(clientMutationId))
          ) {
            ownMutationIdsRef.current.delete(clientMutationId);
            return;
          }

          const patch = workspaceEditorSavePatchEvent(event);
          if (patch) {
            cancelChangedReload();
            await applyRemotePatchEvent(patch, generation);
          } else {
            // A snapshot has no safe delta, and agent/non-editor mutations are
            // intentionally not projected as an editor patch. Rebase the
            // local draft against the authoritative post-commit bytes instead.
            scheduleChangedReload();
          }
          return;
        }

        // Compatibility only for legacy non-editor producers that have not
        // yet moved to the coordinator event. Workspace editor saves use the
        // durable branch above and never rely on this projection.
        if (event.type === "document.patch.applied") {
          if (
            event.clientMutationId &&
            (ownMutationIdsRef.current.has(event.clientMutationId) ||
              consumeLocalArtifactSaveMutation(event.clientMutationId))
          ) {
            if (event.clientMutationId) {
              ownMutationIdsRef.current.delete(event.clientMutationId);
            }
            return;
          }
          cancelChangedReload();
          await applyRemotePatchEvent(event, generation);
          return;
        }

        if (event.type === "changed") {
          if (
            event.clientMutationId &&
            ownMutationIdsRef.current.has(event.clientMutationId)
          ) {
            return;
          }
          if (consumeLocalArtifactSaveMutation(event.clientMutationId)) {
            return;
          }
          scheduleChangedReload();
        }
      }, {
          ...(file.kind === "artifact" ? {
            artifactId: file.id,
            roomId: file.roomId,
          } : {}),
          onReconnect: async () => {
            await runFullResync(patchGenerationRef.current);
          },
        });

    return () => {
      unsub();
      cancelChangedReload();
    };
  }, [
    applyRemotePatchEvent,
    cancelChangedReload,
    file,
    runFullResync,
    scheduleChangedReload,
    subscribeWorkspaceArtifactEvents,
  ]);

  useEffect(() => {
    if (file.kind !== "fs") return;
    const api = desktopAPI;
    if (!api?.fs.onDirectoryChanged) return;

    void api.fs.watchRoot?.(file.rootPath).catch(() => {
      /* best-effort; tree watcher may already cover this root */
    });

    const unsub = api.fs.onDirectoryChanged((evt) => {
      if (!fsDirectoryChangeAffectsFile(evt, file.path)) return;
      void (async () => {
        if (
          evt.patchEvent &&
          evt.reloadRequired !== true &&
          evt.patchEvent.target.kind === "currentFile"
        ) {
          cancelChangedReload();
          const generation = patchGenerationRef.current;
          await applyRemotePatchEvent(evt.patchEvent, generation);
          return;
        }
        let currentSha: string | null = null;
        try {
          const st = await api.fs.stat(file.path);
          if (st.exists && st.isFile) {
            const content = await api.fs.readFile(file.path);
            currentSha = await sha256HexForText(content);
          }
        } catch {
          /* unreadable / gone — fall through to resync */
        }
        if (isLocalFsSaveSha(file.path, currentSha)) return;
        scheduleChangedReload();
      })();
    });

    return () => {
      unsub();
      cancelChangedReload();
    };
  }, [applyRemotePatchEvent, cancelChangedReload, file, scheduleChangedReload]);

  useEffect(
    () => () => {
      clearDebounce();
      cancelChangedReload();
    },
    [cancelChangedReload, clearDebounce],
  );

  return {
    draft,
    dirty,
    status,
    lastSavedAt,
    autosaveEnabled,
    errorMessage,
    conflict,
    conflictLoading: conflict !== null && conflict.latestContent === null && conflictLoadError === null,
    conflictLoadError,
    setDraftFromEditor,
    setAutosaveEnabled: updateAutosaveEnabled,
    saveNow,
    keepMine,
    takeTheirs,
    markMergedAndSave,
    retryConflict,
    saveCopy,
  };
}
