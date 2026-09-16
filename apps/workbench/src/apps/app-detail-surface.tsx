/**
 * D344 — full-width per-app detail page (work surface). Opened from the Apps
 * overview cards or the side-panel `⋯ ▸ Details` item. Shows the app's name,
 * version, description, file associations, and a bundled first-party preview
 * where available, with Launch, Disable, and the pending Uninstall action.
 * Runtime fields render from `PublicMiniAppDto`; branded artwork remains a
 * bounded Workbench concern for Nautilo's bundled apps.
 */

import { useState } from "react";
import { X, ChevronLeft, ImageOff } from "lucide-react";
import type { PublicMiniAppDto } from "@nautilo/api-client/browser";
import { useInstalledApps } from "./use-installed-apps";
import { apiClient } from "../lib/api";
import { requestOpenMiniApp } from "../adapters/open-mini-app-ref";
import { AppIcon, firstPartyAppVisual } from "./first-party-app-visuals";
import { AppDetailSearch } from "./app-detail-search";
import { VideoAppIcon, VideoAppPreview } from "./video-app-presentation";

function associationSummary(app: PublicMiniAppDto): string {
  const fa = app.fileAssociations;
  const exts = (fa?.extensions ?? []).map((e) => e.trim()).filter((e) => e.length > 0);
  if (exts.length > 0) return exts.join(", ");
  const mimes = (fa?.mimeTypes ?? []).map((m) => m.trim()).filter((m) => m.length > 0);
  if (mimes.length > 0) return mimes.join(", ");

  const documentTypes = Array.from(
    new Set(
      (app.contentAssociations ?? [])
        .map((association) => association.match.documentType)
        .filter((documentType): documentType is string =>
          typeof documentType === "string" && documentType.length > 0),
    ),
  );
  if (documentTypes.length > 0) {
    const labels = documentTypes.map(
      (documentType) =>
        `${documentType.charAt(0).toUpperCase()}${documentType.slice(1)} documents`,
    );
    return `${labels.join(", ")} · verified manifest`;
  }

  return "No associations";
}

export function AppDetailSurface({
  appId,
  onClose,
  onBack,
}: {
  appId: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const appsState = useInstalledApps();
  const reload = appsState.reload;
  const app = appsState.kind === "ready" ? appsState.apps.find((a) => a.id === appId) : undefined;
  const visual = firstPartyAppVisual(appId);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [failedPreviewSrc, setFailedPreviewSrc] = useState<string | null>(null);

  const toggleEnabled = (target: PublicMiniAppDto) => {
    setToggling(true);
    setToggleError(null);
    void apiClient
      .setMiniAppEnabled(target.id, target.enabled === false)
      .catch(() => setToggleError("Could not update this app. Try again."))
      .finally(() => {
        setToggling(false);
        reload();
      });
  };

  return (
    <div data-testid="app-detail" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="app-detail-back"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
          All apps
        </button>
        <AppDetailSearch />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="shrink-0 rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {appsState.kind === "loading" ? (
          <p data-testid="app-detail-loading" className="text-xs text-foreground-muted">Loading…</p>
        ) : !app ? (
          <p data-testid="app-detail-not-found" className="text-xs text-foreground-muted">
            App not found.
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 py-2">
            <div className="flex items-center gap-4">
              <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-background-element text-xl text-foreground">
                {app.id === "nautilo-video" ? <VideoAppIcon className="h-8 w-8" /> : <AppIcon appId={app.id} name={app.name?.trim() || app.id} />}
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                  {app.name?.trim() || app.id}
                </h1>
                <p className="mt-1 text-xs text-foreground-muted">
                {app.version ? `v${app.version} · ` : ""}by Nautilo ·{" "}
                {app.enabled === false
                  ? "⊘ Disabled"
                  : app.status === "ready"
                    ? "● Enabled"
                    : "⊘ Unavailable"}
                </p>
              </div>
            </div>

            {app.id === "nautilo-video" ? <VideoAppPreview /> : visual?.previewSrc && failedPreviewSrc !== visual.previewSrc ? (
              <div data-testid="app-detail-screenshot" className="overflow-hidden rounded-xl border border-border bg-background-element shadow-sm">
                <img
                  src={visual.previewSrc}
                  alt={visual.previewAlt ?? `${app.name?.trim() || app.id} preview`}
                  className="h-auto w-full object-contain"
                  onError={() => setFailedPreviewSrc(visual.previewSrc!)}
                />
              </div>
            ) : (
              <div
                data-testid="app-detail-screenshot"
                className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border border-dashed border-border bg-background-element text-foreground-muted"
              >
                <span className="flex items-center gap-2 text-[11px]">
                  <ImageOff aria-hidden="true" className="h-4 w-4" />
                  No preview yet
                </span>
              </div>
            )}

            {app.description?.trim() ? (
              <p data-testid="app-detail-description" className="text-sm leading-relaxed text-foreground">
                {app.description.trim()}
              </p>
            ) : null}

            <p data-testid="app-detail-associations" className="text-xs text-foreground-muted">
              {associationSummary(app)}
            </p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="app-detail-launch"
                disabled={app.status !== "ready" || app.enabled === false}
                onClick={() => requestOpenMiniApp(app.id)}
                className="rounded-md border border-border bg-background-element px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Launch
              </button>
              <button
                type="button"
                disabled={toggling}
                data-testid="app-detail-disable"
                onClick={() => toggleEnabled(app)}
                title={app.enabled === false ? "Enable this app" : "Disable this app (stays installed)"}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {app.enabled === false ? "Enable" : "Disable"}
              </button>
              <button
                type="button"
                disabled
                data-testid="app-detail-uninstall"
                title="Uninstalling apps is coming soon"
                className="cursor-not-allowed rounded-md border border-border px-3 py-1.5 text-xs text-foreground-muted opacity-60"
              >
                Uninstall
              </button>
            </div>
            {toggleError ? <p role="alert" className="text-xs text-[var(--error)]">{toggleError}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}
