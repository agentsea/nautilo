import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Focus, X } from "lucide-react";
import type { OpenFileTarget } from "../components/browser-column/open-file-target";
import { relativeFromWorkspace } from "../components/browser-column/cited-paths";
import { basename, MAX_TEXT_PREVIEW_BYTES } from "../lib/file-preview";
import { desktopAPI } from "../lib/desktop";
import { canEditInThisChannel, editorKindForFile } from "./editor-kind";
import {
  loadEditableText,
  type LoadEditableTextResult,
} from "./editor-io";
import { usePatchDocumentSession, type PatchEditorStatus } from "./use-patch-document-session";
import { deploymentSafeLazy } from "../lib/deployment-safe-lazy";

type EditorSessionStatus = PatchEditorStatus;

type EditorSession = {
  autosaveEnabled: boolean;
  conflict: { latestContent: string | null; currentSha256: string | null } | null;
  dirty: boolean;
  draft: string;
  errorMessage: string | null;
  keepMine: () => Promise<boolean> | boolean | void;
  lastSavedAt: Date | null;
  markMergedAndSave: () => Promise<boolean> | boolean | void;
  saveCopy: () => Promise<boolean> | boolean | void;
  saveNow: (opts: { checkpoint: boolean }) => Promise<boolean> | boolean | void;
  setAutosaveEnabled: (enabled: boolean) => void;
  setDraftFromEditor: (next: string) => void;
  status: EditorSessionStatus;
  takeTheirs: () => void;
};

const MarkdownEditor = deploymentSafeLazy(() =>
  import("./markdown-editor").then((m) => ({ default: m.MarkdownEditor })),
);
const CodeEditor = deploymentSafeLazy(() =>
  import("./code-editor").then((m) => ({ default: m.CodeEditor })),
);

type LoadState =
  | { kind: "loading" }
  | Extract<LoadEditableTextResult, { kind: "ready" }>
  | { kind: "too_large" }
  | { kind: "error"; message: string };

type PendingNavAction = "close" | "view";

export type EditorSurfaceProps = {
  file: OpenFileTarget;
  onView: () => void;
  onClose: () => void;
  onFocus?: () => void;
};

function formatSavedTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function statusPillLabel(
  status: EditorSessionStatus,
  lastSavedAt: Date | null,
): string {
  switch (status) {
    case "patching":
      return "Saving...";
    case "rebasing":
      return "Rebasing...";
    case "resyncing":
      return "Syncing...";
    case "offline-queued":
      return "Offline — queued";
    case "saved":
      return lastSavedAt ? `Saved ${formatSavedTime(lastSavedAt)}` : "Saved";
    case "unsaved":
      return "Unsaved";
    case "failed":
      return "Failed";
    case "conflict":
      return "Conflict";
    default:
      return "Saved";
  }
}

function statusPillClass(status: EditorSessionStatus): string {
  const base =
    "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium";
  switch (status) {
    case "patching":
    case "rebasing":
    case "resyncing":
      return `${base} border-border text-foreground-muted`;
    case "offline-queued":
      return `${base} border-amber-500/40 text-amber-600 dark:text-amber-400`;
    case "saved":
    case "idle":
      return `${base} border-border text-foreground-muted`;
    case "unsaved":
      return `${base} border-amber-500/40 text-amber-600 dark:text-amber-400`;
    case "failed":
      return `${base} border-[var(--error)]/40 text-[var(--error)]`;
    case "conflict":
      return `${base} border-amber-500/40 text-amber-600 dark:text-amber-400`;
    default:
      return `${base} border-border text-foreground-muted`;
  }
}

function fileRemountKey(file: OpenFileTarget): string {
  const token = file.reloadToken ?? 0;
  if (file.kind === "artifact") return `artifact:${file.id}:${token}`;
  return `fs:${file.path}:${token}`;
}

type LoadedEditorProps = {
  file: OpenFileTarget;
  initial: Extract<LoadEditableTextResult, { kind: "ready" }>;
  onView: () => void;
  onClose: () => void;
  onFocus?: () => void;
};

function LoadedEditorBody({
  file,
  editor,
  onView,
  onClose,
  onFocus,
}: LoadedEditorProps & { editor: EditorSession }) {
  const [openError, setOpenError] = useState<string | null>(null);
  const [pendingNav, setPendingNav] = useState<PendingNavAction | null>(null);

  const {
    autosaveEnabled,
    conflict,
    dirty,
    draft,
    errorMessage,
    keepMine,
    lastSavedAt,
    markMergedAndSave,
    saveCopy,
    saveNow,
    setAutosaveEnabled,
    setDraftFromEditor,
    status,
    takeTheirs,
  } = editor;

  const editorKind = editorKindForFile(file);
  const relPath = useMemo(() => {
    if (file.kind === "artifact") return file.path;
    return relativeFromWorkspace(file.rootPath, file.path);
  }, [file]);
  const fileName = basename(file.path);

  const runNavWithDirtyGuard = useCallback(
    async (action: PendingNavAction, proceed: () => void) => {
      if (!dirty) {
        proceed();
        return;
      }
      if (autosaveEnabled) {
        const saved = await saveNow({ checkpoint: true });
        if (saved) proceed();
        return;
      }
      setPendingNav(action);
    },
    [autosaveEnabled, dirty, saveNow],
  );

  const handleClose = useCallback(() => {
    void runNavWithDirtyGuard("close", onClose);
  }, [onClose, runNavWithDirtyGuard]);

  const handleView = useCallback(() => {
    void runNavWithDirtyGuard("view", onView);
  }, [onView, runNavWithDirtyGuard]);

  const handleConfirmSave = useCallback(async () => {
    const action = pendingNav;
    setPendingNav(null);
    const saved = await saveNow({ checkpoint: true });
    if (!saved) return;
    if (action === "view") onView();
    else onClose();
  }, [onClose, onView, pendingNav, saveNow]);

  const handleConfirmDiscard = useCallback(() => {
    const action = pendingNav;
    setPendingNav(null);
    if (action === "view") onView();
    else onClose();
  }, [onClose, onView, pendingNav]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void saveNow({ checkpoint: true });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveNow]);

  useEffect(() => {
    const onWindowBlur = () => {
      if (autosaveEnabled && dirty) {
        void saveNow({ checkpoint: true });
      }
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [autosaveEnabled, dirty, saveNow]);

  const handleBlurCapture = useCallback(() => {
    if (autosaveEnabled && dirty) {
      void saveNow({ checkpoint: true });
    }
  }, [autosaveEnabled, dirty, saveNow]);

  const headerButtonClass =
    "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section
      className="grid h-full min-w-0 grid-rows-[48px_1fr] overflow-hidden bg-background"
      onBlurCapture={handleBlurCapture}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{fileName}</h2>
          <div className="truncate text-[11px] text-foreground-muted">{relPath}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <div
            className="flex rounded-md border border-border p-0.5 text-xs"
            role="group"
            aria-label="View or edit"
          >
            <button
              type="button"
              onClick={handleView}
              className="rounded px-2 py-0.5 text-foreground-muted hover:bg-background-element hover:text-foreground"
            >
              View
            </button>
            <button
              type="button"
              aria-current="true"
              className="rounded bg-background-element px-2 py-0.5 font-medium text-foreground"
            >
              Edit
            </button>
          </div>

          <span className={statusPillClass(status)}>
            {statusPillLabel(status, lastSavedAt)}
          </span>

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground-muted">
            <input
              type="checkbox"
              checked={autosaveEnabled}
              onChange={(e) => setAutosaveEnabled(e.target.checked)}
              className="rounded border-border"
            />
            Autosave
          </label>

          {onFocus ? (
            <button type="button" onClick={onFocus} className={`${headerButtonClass} inline-flex items-center gap-1`}>
              <Focus aria-hidden="true" className="h-3.5 w-3.5" />
              Focus
            </button>
          ) : null}

          {file.kind === "fs" ? (
            <button
              type="button"
              onClick={() => {
                setOpenError(null);
                void desktopAPI?.fs.openPath(file.path).catch((err) => {
                  setOpenError(err instanceof Error ? err.message : String(err));
                });
              }}
              disabled={!desktopAPI}
              className={headerButtonClass}
            >
              Open in default app
            </button>
          ) : null}

          <button
            type="button"
            onClick={handleClose}
            aria-label="Close editor"
            title="Close editor"
            className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-col overflow-hidden">
        {openError ? (
          <div className="mx-4 mt-3 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
            {openError}
          </div>
        ) : null}

        {errorMessage ? (
          <div className="mx-4 mt-3 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
            {errorMessage}
          </div>
        ) : null}

        {pendingNav ? (
          <div className="mx-4 mt-3 rounded-md border border-border bg-background-panel p-3 text-sm">
            <p className="text-foreground-muted">You have unsaved changes.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleConfirmSave()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
              >
                {pendingNav === "view" ? "Save and view" : "Save and close"}
              </button>
              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground"
              >
                {pendingNav === "view" ? "Discard and view" : "Discard"}
              </button>
              <button
                type="button"
                onClick={() => setPendingNav(null)}
                className="rounded-md px-3 py-1.5 text-xs text-foreground-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {conflict ? (
          <div className="mx-4 mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium text-foreground">
              This file changed elsewhere while you were editing.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-foreground-muted">Your draft</div>
                <pre className="max-h-48 overflow-auto rounded border border-border bg-background-panel p-2 text-xs whitespace-pre-wrap">
                  {draft}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-foreground-muted">Latest version</div>
                <pre className="max-h-48 overflow-auto rounded border border-border bg-background-panel p-2 text-xs whitespace-pre-wrap">
                  {conflict.latestContent ?? "Loading latest version..."}
                </pre>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void saveCopy()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
              >
                Save a copy
              </button>
              <button
                type="button"
                onClick={() => void keepMine()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
              >
                Keep mine
              </button>
              <button
                type="button"
                onClick={() => takeTheirs()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
              >
                Take theirs
              </button>
              <button
                type="button"
                onClick={() => void markMergedAndSave()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
              >
                Merge and save
              </button>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
          <Suspense
            fallback={
              <div className="px-4 py-5 text-sm text-foreground-muted">Loading editor...</div>
            }
          >
            {editorKind === "markdown" ? (
              <MarkdownEditor
                value={draft}
                onChange={setDraftFromEditor}
                diffMarkdown={conflict?.latestContent ?? undefined}
              />
            ) : (
              <CodeEditor
                value={draft}
                onChange={setDraftFromEditor}
                path={file.path}
              />
            )}
          </Suspense>
        </div>
      </div>
    </section>
  );
}

function PatchLoadedEditor(props: LoadedEditorProps) {
  const { file, initial } = props;

  const loadLatest = useCallback(() => loadEditableText(file), [file]);

  const editor = usePatchDocumentSession({
    file,
    initialContent: initial.content,
    baseSha256: initial.baseSha256,
    baseRevision: initial.baseRevision,
    loadLatest,
  });

  return <LoadedEditorBody {...props} editor={editor} />;
}

function LoadedEditor(props: LoadedEditorProps) {
  return <PatchLoadedEditor {...props} />;
}

export function EditorSurface({
  file,
  onView,
  onClose,
  onFocus,
}: EditorSurfaceProps) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const remountKey = fileRemountKey(file);

  const relPath = useMemo(() => {
    if (file.kind === "artifact") return file.path;
    return relativeFromWorkspace(file.rootPath, file.path);
  }, [file]);
  const fileName = basename(file.path);
  const editable = canEditInThisChannel(file, !!desktopAPI);

  // Reload is keyed on the STABLE `remountKey` (kind + id/path + reloadToken),
  // NOT the `file` object identity. The shell hands us a fresh `file` object on
  // every artifact SSE event (and on its own-save no-op branch); keying on the
  // object would reload on every save and defeat own-save suppression. We read
  // the latest target through a ref so the effect deps stay identity-stable.
  const fileRef = useRef(file);
  fileRef.current = file;

  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    const target = fileRef.current;
    setLoadState({ kind: "loading" });
    void (async () => {
      const result = await loadEditableText(target);
      if (!cancelled) {
        if (result.kind === "ready") {
          setLoadState(result);
        } else if (result.kind === "too_large") {
          setLoadState({ kind: "too_large" });
        } else {
          setLoadState({ kind: "error", message: result.message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editable, remountKey]);

  const headerButtonClass =
    "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground";

  if (!editable) {
    return (
      <section className="grid h-full min-w-0 grid-rows-[48px_1fr] overflow-hidden bg-background">
        <header className="flex items-center justify-between border-b border-border px-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{fileName}</h2>
            <div className="truncate text-[11px] text-foreground-muted">{relPath}</div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onView} className={headerButtonClass}>
              View
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close editor"
              title="Close editor"
              className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="px-6 py-5">
          <div className="rounded-md border border-border bg-background-panel p-4 text-sm text-foreground-muted">
            This file cannot be edited in this environment.
            {file.kind === "fs" && !desktopAPI
              ? " Local files are editable only in the desktop app."
              : null}
          </div>
        </div>
      </section>
    );
  }

  if (loadState.kind === "ready") {
    return (
      <LoadedEditor
        key={remountKey}
        file={file}
        initial={loadState}
        onView={onView}
        onClose={onClose}
        onFocus={onFocus}
      />
    );
  }

  return (
    <section className="grid h-full min-w-0 grid-rows-[48px_1fr] overflow-hidden bg-background">
      {loadState.kind === "loading" ? (
        <>
          <header className="flex items-center justify-between border-b border-border px-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">{fileName}</h2>
              <div className="truncate text-[11px] text-foreground-muted">{relPath}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close editor"
              title="Close editor"
              className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>
          <div className="px-6 py-5 text-sm text-foreground-muted">Loading file...</div>
        </>
      ) : loadState.kind === "too_large" ? (
        <>
          <header className="flex items-center justify-between border-b border-border px-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">{fileName}</h2>
              <div className="truncate text-[11px] text-foreground-muted">{relPath}</div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onView} className={headerButtonClass}>
                View
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close editor"
                className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="px-6 py-5">
            <div className="rounded-md border border-border bg-background-panel p-4 text-sm text-foreground-muted">
              File is too large to edit here (max {Math.round(MAX_TEXT_PREVIEW_BYTES / (1024 * 1024))} MB).
              {file.kind === "fs" ? (
                <button
                  type="button"
                  onClick={() => void desktopAPI?.fs.openPath(file.path)}
                  disabled={!desktopAPI}
                  className="mt-3 block rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Open in default app
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : loadState.kind === "error" ? (
        <>
          <header className="flex items-center justify-between border-b border-border px-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">{fileName}</h2>
              <div className="truncate text-[11px] text-foreground-muted">{relPath}</div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onView} className={headerButtonClass}>
                View
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close editor"
                className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="px-6 py-5">
            <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
              {loadState.message}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
