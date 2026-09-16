import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadEditableTextResult, SaveEditableTextResult } from "./editor-io";

export const AUTOSAVE_DEBOUNCE_MS = 750;
export const AUTOSAVE_STORAGE_KEY = "nautilo:editor:autosave";

export type DocEditorStatus =
  | "idle"
  | "saving"
  | "saved"
  | "failed"
  | "conflict"
  | "unsaved";

export type DocEditorConflict = {
  latestContent: string | null;
  currentSha256: string | null;
};

type SaveFn = (
  content: string,
  base: { sha256: string | null; revision: number | null },
  checkpoint: boolean,
  options?: { clientMutationId?: string },
) => Promise<SaveEditableTextResult>;

export type UseDocEditorOptions = {
  initialContent: string;
  baseSha256: string;
  baseRevision: number | null;
  save: SaveFn;
  loadLatest?: () => Promise<LoadEditableTextResult>;
};

function readAutosaveFromStorage(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return (localStorage.getItem(AUTOSAVE_STORAGE_KEY) ?? "on") !== "off";
  } catch {
    return true;
  }
}

export function getAutosaveEnabled(): boolean {
  return readAutosaveFromStorage();
}

export function setAutosaveEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(AUTOSAVE_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // ignore storage failures
  }
}

export function useDocEditor({
  initialContent,
  baseSha256,
  baseRevision,
  save,
  loadLatest,
}: UseDocEditorOptions) {
  const [draft, setDraft] = useState(initialContent);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<DocEditorStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [autosaveEnabled, setAutosaveEnabledState] = useState(getAutosaveEnabled);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DocEditorConflict | null>(null);

  const draftRef = useRef(initialContent);
  const savedContentRef = useRef(initialContent);
  const baseShaRef = useRef(baseSha256);
  const baseRevisionRef = useRef(baseRevision);
  const autosaveEnabledRef = useRef(autosaveEnabled);
  const conflictRef = useRef<DocEditorConflict | null>(null);
  const firstCheckpointPendingRef = useRef(true);
  const saveGenerationRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictLatestRef = useRef<{
    content: string;
    sha256: string;
    revision: number | null;
  } | null>(null);

  useEffect(() => {
    autosaveEnabledRef.current = autosaveEnabled;
  }, [autosaveEnabled]);

  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  useEffect(() => {
    draftRef.current = initialContent;
    savedContentRef.current = initialContent;
    baseShaRef.current = baseSha256;
    baseRevisionRef.current = baseRevision;
    firstCheckpointPendingRef.current = true;
    conflictLatestRef.current = null;
    conflictRef.current = null;
    setDraft(initialContent);
    setDirty(false);
    setStatus("idle");
    setErrorMessage(null);
    setConflict(null);
    setLastSavedAt(null);
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, [initialContent, baseSha256, baseRevision]);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const applySaveResult = useCallback(
    async (
      result: SaveEditableTextResult,
      contentSaved: string,
      generation: number,
    ): Promise<boolean> => {
      if (generation !== saveGenerationRef.current) return false;
      if (draftRef.current !== contentSaved) {
        setStatus(draftRef.current !== savedContentRef.current ? "unsaved" : "idle");
        return false;
      }

      if (result.kind === "saved") {
        savedContentRef.current = contentSaved;
        baseShaRef.current = result.newSha256;
        if (result.revision !== undefined) {
          baseRevisionRef.current = result.revision;
        }
        conflictLatestRef.current = null;
        conflictRef.current = null;
        setDirty(false);
        setConflict(null);
        setErrorMessage(null);
        setStatus("saved");
        setLastSavedAt(new Date());
        return true;
      }

      if (result.kind === "conflict") {
        const nextConflict = {
          latestContent: null,
          currentSha256: result.currentSha256,
        };
        conflictRef.current = nextConflict;
        setStatus("conflict");
        setConflict(nextConflict);
        conflictLatestRef.current = null;

        if (loadLatest) {
          const latest = await loadLatest();
          if (generation !== saveGenerationRef.current) return false;
          if (latest.kind === "ready") {
            conflictLatestRef.current = {
              content: latest.content,
              sha256: latest.baseSha256,
              revision: latest.baseRevision,
            };
            const resolvedConflict = {
              latestContent: latest.content,
              currentSha256: result.currentSha256,
            };
            conflictRef.current = resolvedConflict;
            setConflict(resolvedConflict);
          }
        }
        return false;
      }

      setStatus("failed");
      setErrorMessage(result.message);
      return false;
    },
    [loadLatest],
  );

  const runSave = useCallback(
    async (checkpoint: boolean) => {
      const generation = ++saveGenerationRef.current;
      const content = draftRef.current;

      setStatus("saving");
      setErrorMessage(null);

      const clientMutationId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `editor-save-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const result = await save(
        content,
        {
          sha256: baseShaRef.current,
          revision: baseRevisionRef.current,
        },
        checkpoint,
        { clientMutationId },
      );

      return await applySaveResult(result, content, generation);
    },
    [applySaveResult, save],
  );

  const runForceSave = useCallback(
    async (checkpoint: boolean) => {
      const generation = ++saveGenerationRef.current;
      const content = draftRef.current;

      setStatus("saving");
      setErrorMessage(null);

      const clientMutationId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `editor-save-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const result = await save(
        content,
        { sha256: null, revision: null },
        checkpoint,
        { clientMutationId },
      );
      return await applySaveResult(result, content, generation);
    },
    [applySaveResult, save],
  );

  const scheduleAutosave = useCallback(
    (checkpoint: boolean) => {
      clearDebounce();
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void runSave(checkpoint);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [clearDebounce, runSave],
  );

  const setDraftFromEditor = useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);

      const isDirty = next !== savedContentRef.current;
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
      return runSave(checkpoint);
    },
    [clearDebounce, runSave],
  );

  const keepMine = useCallback(() => {
    clearDebounce();
    return runForceSave(true);
  }, [clearDebounce, runForceSave]);

  const takeTheirs = useCallback(() => {
    const latest = conflictLatestRef.current?.content ?? conflict?.latestContent;
    if (!latest) return;

    draftRef.current = latest;
    savedContentRef.current = latest;
    if (conflictLatestRef.current) {
      baseShaRef.current = conflictLatestRef.current.sha256;
      baseRevisionRef.current = conflictLatestRef.current.revision;
    }

    setDraft(latest);
    setDirty(false);
    conflictRef.current = null;
    setConflict(null);
    conflictLatestRef.current = null;
    setStatus("idle");
    setErrorMessage(null);
  }, [conflict]);

  const markMergedAndSave = useCallback(() => {
    clearDebounce();
    return runSave(true);
  }, [clearDebounce, runSave]);

  useEffect(() => () => clearDebounce(), [clearDebounce]);

  return {
    draft,
    dirty,
    status,
    lastSavedAt,
    autosaveEnabled,
    errorMessage,
    conflict,
    setDraftFromEditor,
    setAutosaveEnabled: updateAutosaveEnabled,
    saveNow,
    keepMine,
    takeTheirs,
    markMergedAndSave,
  };
}
