import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AppSourceTarget } from "../adapters/open-app-source-ref";
import { requestOpenMiniApp } from "../adapters/open-mini-app-ref";
import {
  loadAppSourceFile,
  saveAppSourceFile,
  type LoadAppSourceResult,
  type SaveAppSourceResult,
} from "./app-source-io";
import { useDocEditor, type DocEditorStatus } from "../editors/use-doc-editor";
import { deploymentSafeLazy } from "../lib/deployment-safe-lazy";

const CodeEditor = deploymentSafeLazy(() =>
  import("../editors/code-editor").then((m) => ({ default: m.CodeEditor })),
);

type LoadState =
  | { kind: "loading" }
  | Extract<LoadAppSourceResult, { kind: "ready" }>
  | { kind: "error"; message: string };

export type AppSourceEditorSurfaceProps = {
  target: AppSourceTarget;
  onClose: () => void;
};

function statusPillLabel(status: DocEditorStatus, lastSavedAt: Date | null): string {
  switch (status) {
    case "saving":
      return "Saving...";
    case "saved":
      return lastSavedAt
        ? `Saved ${lastSavedAt.getHours().toString().padStart(2, "0")}:${lastSavedAt.getMinutes().toString().padStart(2, "0")}`
        : "Saved";
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

function statusPillClass(status: DocEditorStatus): string {
  const base = "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium";
  switch (status) {
    case "unsaved":
    case "conflict":
      return `${base} border-amber-500/40 text-amber-600 dark:text-amber-400`;
    case "failed":
      return `${base} border-[var(--error)]/40 text-[var(--error)]`;
    default:
      return `${base} border-border text-foreground-muted`;
  }
}

function LoadedAppSourceEditor({
  target,
  initial,
  onClose,
}: {
  target: AppSourceTarget;
  initial: Extract<LoadAppSourceResult, { kind: "ready" }>;
  onClose: () => void;
}) {
  const [savedSourceHash, setSavedSourceHash] = useState<string | null>(null);
  const saveFn = useCallback(
    async (content: string, base: { sha256: string | null; revision: number | null }) => {
      if (base.sha256 == null) {
        return { kind: "error" as const, message: "Missing base checksum." };
      }
      const result: SaveAppSourceResult = await saveAppSourceFile(target, content, base.sha256);
      if (result.kind === "saved") {
        setSavedSourceHash(result.sourceHash);
      }
      return result;
    },
    [target],
  );

  const loadLatest = useCallback(() => loadAppSourceFile(target), [target]);

  const editor = useDocEditor({
    initialContent: initial.content,
    baseSha256: initial.baseSha256,
    baseRevision: initial.baseRevision,
    save: saveFn,
    loadLatest,
  });
  const saveNow = editor.saveNow;

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

  return (
    <section className="grid h-full min-w-0 grid-rows-[48px_1fr] overflow-hidden bg-background">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{target.path}</h2>
          <div className="truncate text-[11px] text-foreground-muted">
            App source · {target.appId}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={statusPillClass(editor.status)}>
            {statusPillLabel(editor.status, editor.lastSavedAt)}
          </span>
          <button
            type="button"
            onClick={() => void saveNow({ checkpoint: true })}
            disabled={editor.status === "saving"}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close source editor"
            title="Close source editor"
            className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-col overflow-hidden">
        {savedSourceHash ? (
          <div
            data-testid="app-source-reload-banner"
            className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          >
            <div className="min-w-0">
              <p className="font-medium text-foreground">Source saved.</p>
              <p className="mt-0.5 text-xs text-foreground-muted">
                Reload the app when you are ready to rebuild the running preview.
              </p>
            </div>
            <button
              type="button"
              onClick={() => requestOpenMiniApp(target.appId)}
              className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
            >
              Reload app
            </button>
          </div>
        ) : null}

        {editor.errorMessage ? (
          <div className="mx-4 mt-3 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
            {editor.errorMessage}
          </div>
        ) : null}

        {editor.conflict ? (
          <div
            data-testid="app-source-conflict"
            className="mx-4 mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          >
            <p className="font-medium text-foreground">
              This file changed elsewhere while you were editing.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-foreground-muted">Your draft</div>
                <pre className="max-h-48 overflow-auto rounded border border-border bg-background-panel p-2 text-xs whitespace-pre-wrap">
                  {editor.draft}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-foreground-muted">Latest version</div>
                <pre className="max-h-48 overflow-auto rounded border border-border bg-background-panel p-2 text-xs whitespace-pre-wrap">
                  {editor.conflict.latestContent ?? "Loading latest version..."}
                </pre>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void editor.keepMine()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
              >
                Keep mine
              </button>
              <button
                type="button"
                onClick={() => editor.takeTheirs()}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element"
              >
                Reload latest
              </button>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          <Suspense
            fallback={
              <div className="px-4 py-5 text-sm text-foreground-muted">Loading editor...</div>
            }
          >
            <CodeEditor
              value={editor.draft}
              onChange={editor.setDraftFromEditor}
              path={target.path}
            />
          </Suspense>
        </div>
      </div>
    </section>
  );
}

export function AppSourceEditorSurface({ target, onClose }: AppSourceEditorSurfaceProps) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const remountKey = `${target.appId}:${target.path}`;
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    let cancelled = false;
    const loadTarget = targetRef.current;
    setLoadState({ kind: "loading" });
    void (async () => {
      const result = await loadAppSourceFile(loadTarget);
      if (!cancelled) {
        if (result.kind === "ready") {
          setLoadState(result);
        } else {
          setLoadState({ kind: "error", message: result.message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remountKey]);

  if (loadState.kind === "ready") {
    return (
      <LoadedAppSourceEditor key={remountKey} target={target} initial={loadState} onClose={onClose} />
    );
  }

  return (
    <section className="grid h-full min-w-0 grid-rows-[48px_1fr] overflow-hidden bg-background">
      <header className="flex items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{target.path}</h2>
          <div className="truncate text-[11px] text-foreground-muted">
            App source · {target.appId}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close source editor"
          title="Close source editor"
          className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      {loadState.kind === "loading" ? (
        <div className="px-6 py-5 text-sm text-foreground-muted">Loading source file...</div>
      ) : (
        <div className="px-6 py-5">
          <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
            {loadState.message}
          </div>
        </div>
      )}
    </section>
  );
}
