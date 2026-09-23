import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { PublicMiniAppDto } from "@nautilo/api-client/browser";
import { requestOpenMiniApp, supportsMiniAppPreview } from "../../adapters/open-mini-app-ref";
import { requestOpenOfficeDoc } from "../../adapters/open-office-doc-ref";
import { isOfficeDocPath } from "../../viewers/file-kind";
import {
  isHtmlAssociationCandidate,
  matchingImportActionsForFile,
  matchingReadyAppsForFile,
  matchingReadyAppsForFileWithContent,
  type AppImportActionMatch,
} from "../../apps/app-associations";
import { readFileTextForAssociation } from "../../apps/association-content-io";
import {
  buildImportRequest,
  importActionLabel,
  openImportedResult,
  type ImportToolResult,
} from "../../apps/run-conversion";
import { useConversionRunner } from "../../apps/use-conversion-runner";
import { useInstalledApps } from "../../apps/use-installed-apps";
import { canEditInThisChannel } from "../../editors/editor-kind";
import { desktopAPI } from "../../lib/desktop";
import { isUnderRoot, relativeFromWorkspace } from "../browser-column/cited-paths";
import type { OpenFileTarget } from "../browser-column/open-file-target";
import {
  basename,
  MAX_TEXT_PREVIEW_BYTES,
} from "../../lib/file-preview";
import { adapterForFile } from "../../viewers/registry";
import type {
  ArtifactViewerByteSource,
  ViewerAdapter,
  ViewerLoadResult,
} from "../../viewers/types";

const BINARY_PREVIEW_LOAD_TIMEOUT_MS = 35_000;

export type ReaderFile = OpenFileTarget;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; adapter: ViewerAdapter; data: unknown }
  | { kind: "unsupported"; ext: string | null }
  | { kind: "too_large"; sizeBytes: number; maxBytes: number }
  | { kind: "error"; message: string };

function associationTargetIdentity(file: OpenFileTarget): string {
  return file.kind === "artifact"
    ? `artifact:${file.roomId ?? ""}:${file.id}:${file.path}:${file.reloadToken ?? 0}`
    : `fs:${file.rootPath}:${file.path}:${file.reloadToken ?? 0}`;
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function isXlsxPath(path: string): boolean {
  return path.toLowerCase().endsWith(".xlsx");
}

function displayAppName(app: PublicMiniAppDto): string {
  const name = app.name?.trim();
  return name && name.length > 0 ? name : app.id;
}

function openInAppLabel(app: PublicMiniAppDto): string {
  return `Open in ${displayAppName(app)}`;
}

function ReaderActionButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function isNetworkLoadError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && /failed to fetch|network|load failed/i.test(err.message))
  );
}

async function readAssociationTextWithRetry(file: OpenFileTarget): Promise<string | null> {
  const retryDelaysMs = [300, 700, 1400];
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFileTextForAssociation(file);
    } catch (err) {
      const delay = retryDelaysMs[attempt];
      if (!isNetworkLoadError(err) || delay === undefined) return null;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function ReaderSurface({
  file,
  onClose,
  onEdit,
  officeEnabled = false,
  artifactBytes,
}: {
  file: ReaderFile;
  onClose: () => void;
  onEdit?: (file: ReaderFile) => void;
  officeEnabled?: boolean;
  /** Explicit dormant protected-Artifact viewer ingress; never globally registered. */
  artifactBytes?: ArtifactViewerByteSource;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const displayedTargetRef = useRef<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [runningImportKey, setRunningImportKey] = useState<string | null>(null);
  const [openWithAppsResult, setOpenWithAppsResult] = useState<{
    targetIdentity: string;
    apps: PublicMiniAppDto[];
  } | null>(null);
  const previewDispatchRef = useRef<string | null>(null);
  const installedApps = useInstalledApps();
  const conversionRunner = useConversionRunner();
  const adapter = useMemo(() => adapterForFile(file), [file]);
  const associationIdentity = associationTargetIdentity(file);
  const importMatches = useMemo(
    () =>
      installedApps.kind === "ready"
        ? matchingImportActionsForFile(installedApps.apps, file)
        : [],
    [installedApps, file],
  );
  const relPath = useMemo(() => {
    if (file.kind === "artifact") return file.path;
    return relativeFromWorkspace(file.rootPath, file.path);
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    setOpenWithAppsResult({ targetIdentity: associationIdentity, apps: [] });
    if (installedApps.kind !== "ready" || isXlsxPath(file.path)) return;

    // For HTML-association candidates we must read the content: a native
    // Nautilo document manifest is authoritative over any app's bare-`.html`
    // extension claim. `matchingReadyAppsForFileWithContent` encapsulates the
    // precedence (manifest → content-only/suppress extension; no manifest →
    // extension/mime), so we route HTML through it rather than short-circuiting
    // on a metadata match. Non-HTML files resolve by extension/mime (no read).
    if (isHtmlAssociationCandidate(file)) {
      void (async () => {
        const content = await readAssociationTextWithRetry(file);
        if (cancelled) return;
        const matches = matchingReadyAppsForFileWithContent(installedApps.apps, file, content);
        setOpenWithAppsResult({
          targetIdentity: associationIdentity,
          apps: matches.map((match) => match.app),
        });
      })();
      return () => {
        cancelled = true;
      };
    }

    setOpenWithAppsResult({
      targetIdentity: associationIdentity,
      apps: matchingReadyAppsForFile(installedApps.apps, file).map((match) => match.app),
    });
  }, [associationIdentity, installedApps, file]);

  const handleImport = useCallback(
    async (match: AppImportActionMatch): Promise<void> => {
      const key = `${match.app.id}:${match.action.id}`;
      const roomId = file.kind === "artifact" ? file.roomId : undefined;
      setImportError(null);
      setRunningImportKey(key);
      try {
        const outcome = await conversionRunner.run(
          match.app.id,
          buildImportRequest(match.action, file),
        );
        if (outcome.status === "error") {
          setImportError(outcome.message);
          return;
        }
        if (outcome.status === "cancelled") return;
        const result = outcome.result as ImportToolResult;
        if (result.status !== "imported") {
          setImportError(result.message ?? result.error ?? "Import failed");
          return;
        }
        await openImportedResult(match.app, match.action, file, result, roomId);
      } finally {
        setRunningImportKey(null);
      }
    },
    [conversionRunner, file],
  );

  useEffect(() => {
    if (file.kind === "fs") {
      if (!isUnderRoot(file.rootPath, file.path)) {
        displayedTargetRef.current = null;
        setState({ kind: "error", message: "Path is not under the expected folder." });
        return;
      }
    }
    if (!adapter) {
      const ext = (() => {
        const name = basename(file.path);
        const dot = name.lastIndexOf(".");
        return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : null;
      })();
      displayedTargetRef.current = null;
      setState({ kind: "unsupported", ext });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const deadlineAt = Date.now() + BINARY_PREVIEW_LOAD_TIMEOUT_MS;
    const targetIdentity = file.kind === "artifact"
      ? `artifact:${file.roomId ?? ""}:${file.id}:${file.path}`
      : `fs:${file.rootPath}:${file.path}`;
    const deadlineTimer = setTimeout(() => {
      controller.abort(new DOMException("Preview timed out. Try again.", "TimeoutError"));
    }, BINARY_PREVIEW_LOAD_TIMEOUT_MS);
    // A changed artifact revision refreshes in place. Keep the last readable
    // document mounted while its next version is fetched.
    setState((current) => current.kind === "ready" && displayedTargetRef.current === targetIdentity
      ? current : { kind: "loading" });

    // A load can lose the race with app startup / reconnect: right after
    // an Electron restart the reader re-opens its last target and fires
    // the artifact fetch before the server is reachable, which rejects
    // with a network-level "Failed to fetch" (TypeError). Without a retry
    // that terminal error sticks forever — re-selecting the same file is
    // the same target identity, so this effect never re-runs. Bounded
    // auto-retry with backoff covers the typical post-restart boot window;
    // the Retry button in the error state handles anything past that.
    const retryDelaysMs = [400, 800, 1600, 3000];

    void (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const result: ViewerLoadResult = await adapter.load(file, {
              maxTextBytes: MAX_TEXT_PREVIEW_BYTES,
              signal: controller.signal,
              deadlineAt,
              ...(artifactBytes === undefined ? {} : { artifactBytes }),
            });
            if (cancelled) return;
            if (result.kind === "ready") {
              displayedTargetRef.current = targetIdentity;
              setState({ ...result, adapter });
            } else {
              displayedTargetRef.current = null;
              setState(result);
            }
            return;
          } catch (err) {
            if (cancelled) return;
            const delay = retryDelaysMs[attempt];
            if (!controller.signal.aborted && isNetworkLoadError(err) && delay !== undefined) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              if (cancelled) return;
              continue;
            }
            setState({
              kind: "error",
              message: controller.signal.reason instanceof DOMException &&
                controller.signal.reason.name === "TimeoutError"
                ? "Preview timed out. Try again."
                : err instanceof Error ? err.message : String(err),
            });
            displayedTargetRef.current = null;
            return;
          }
        }
      } finally {
        clearTimeout(deadlineTimer);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(deadlineTimer);
      controller.abort(new DOMException("Reader selection changed.", "AbortError"));
    };
  }, [adapter, artifactBytes, file, retryNonce]);

  const fileName = basename(file.path);
  const openWithApps = openWithAppsResult?.targetIdentity === associationIdentity
    ? openWithAppsResult.apps
    : [];
  const primaryApp = openWithApps[0] ?? null;
  useEffect(() => {
    if (primaryApp === null || !supportsMiniAppPreview(primaryApp.id)) return;
    const targetIdentity = file.kind === "artifact"
      ? `artifact:${file.roomId ?? ""}:${file.id}`
      : `fs:${file.rootPath}:${file.path}`;
    const dispatchIdentity = `${primaryApp.id}:${targetIdentity}`;
    if (previewDispatchRef.current === dispatchIdentity) return;
    previewDispatchRef.current = dispatchIdentity;
    requestOpenMiniApp(primaryApp.id, file, { mode: "preview" });
  }, [file, primaryApp]);
  const showGenericEdit =
    primaryApp === null &&
    onEdit !== undefined &&
    canEditInThisChannel(file, !!desktopAPI);
  const secondaryOpenWithApps = primaryApp === null ? openWithApps : openWithApps.slice(1);

  return (
    <section className="grid h-full min-w-0 grid-rows-[48px_1fr] overflow-hidden bg-background">
      <header className="flex items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{fileName}</h2>
          <div className="truncate text-[11px] text-foreground-muted">{relPath}</div>
        </div>
        <div className="flex items-center gap-2">
          {primaryApp !== null ? (
            <ReaderActionButton
              onClick={() => requestOpenMiniApp(primaryApp.id, file)}
              title={`${openInAppLabel(primaryApp)} for editing`}
            >
              {openInAppLabel(primaryApp)}
            </ReaderActionButton>
          ) : null}
          {showGenericEdit ? (
            <ReaderActionButton onClick={() => onEdit?.(file)}>Edit Source</ReaderActionButton>
          ) : null}
          {officeEnabled && file.kind === "artifact" && isOfficeDocPath(file.path) ? (
            <button
              type="button"
              onClick={() =>
                requestOpenOfficeDoc({
                  artifactId: file.id,
                  displayName: fileName,
                  documentPath: file.path,
                  ...(file.roomId !== undefined ? { roomId: file.roomId } : {}),
                })
              }
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground-muted hover:bg-background-element hover:text-foreground"
            >
              Open in Office
            </button>
          ) : null}
          {secondaryOpenWithApps.map((app) => (
            <ReaderActionButton
              key={app.id}
              onClick={() => requestOpenMiniApp(app.id, file)}
            >
              {openInAppLabel(app)}
            </ReaderActionButton>
          ))}
          {importMatches.map((match) => {
            const key = `${match.app.id}:${match.action.id}`;
            return (
              <ReaderActionButton
                key={key}
                onClick={() => void handleImport(match)}
                disabled={runningImportKey !== null}
              >
                {runningImportKey === key ? "Importing..." : importActionLabel(match.app)}
              </ReaderActionButton>
            );
          })}
          {installedApps.kind === "error" && isHtmlAssociationCandidate(file) ? (
            <ReaderActionButton
              onClick={installedApps.reload}
              title={`Could not load app associations: ${installedApps.message}`}
            >
              Retry Apps
            </ReaderActionButton>
          ) : null}
          {file.kind === "fs" ? (
            <ReaderActionButton
              onClick={() => {
                setOpenError(null);
                void desktopAPI?.fs.openPath(file.path).catch((err) => {
                  setOpenError(err instanceof Error ? err.message : String(err));
                });
              }}
              disabled={!desktopAPI}
            >
              Open Externally
            </ReaderActionButton>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close reader"
            title="Close reader"
            className="rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-col overflow-y-auto px-6 py-5">
        {openError && (
          <div className="mb-3 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
            {openError}
          </div>
        )}
        {importError && (
          <div className="mb-3 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
            {importError}
          </div>
        )}
        {state.kind === "loading" && (
          <div className="text-sm text-foreground-muted">Loading file...</div>
        )}
        {state.kind === "error" && (
          <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
            <div>{state.message}</div>
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              className="mt-3 rounded-md border border-[var(--error)]/40 px-3 py-1.5 text-xs font-medium text-[var(--error)] hover:bg-[var(--error)]/10"
            >
              Retry
            </button>
          </div>
        )}
        {state.kind === "too_large" && (
          <div className="rounded-md border border-border bg-background-panel p-4 text-sm text-foreground-muted">
            <div>
              This file is too large to preview here ({formatMegabytes(state.sizeBytes)}; max{" "}
              {formatMegabytes(state.maxBytes)}).
            </div>
            {importMatches.map((match) => {
              const key = `${match.app.id}:${match.action.id}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => void handleImport(match)}
                  disabled={runningImportKey !== null}
                  className="mt-3 mr-2 rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {runningImportKey === key ? "Importing..." : importActionLabel(match.app)}
                </button>
              );
            })}
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
                className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
              >
                Open in default app
              </button>
            ) : null}
          </div>
        )}
        {state.kind === "unsupported" && (
          <div className="rounded-md border border-border bg-background-panel p-4 text-sm text-foreground-muted">
            <div>
              Preview is not available for {state.ext ?? "this file type"} yet.
            </div>
            {importMatches.map((match) => {
              const key = `${match.app.id}:${match.action.id}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => void handleImport(match)}
                  disabled={runningImportKey !== null}
                  className="mt-3 mr-2 rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {runningImportKey === key ? "Importing..." : importActionLabel(match.app)}
                </button>
              );
            })}
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
                className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-element disabled:cursor-not-allowed disabled:opacity-50"
              >
                Open in default app
              </button>
            ) : null}
          </div>
        )}
        {state.kind === "ready" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <state.adapter.Component file={file} data={state.data} />
          </div>
        )}
      </div>
      {conversionRunner.conflictDialog}
    </section>
  );
}
