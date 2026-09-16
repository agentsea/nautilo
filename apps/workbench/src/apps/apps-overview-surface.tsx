/**
 * D344 — full-width "Apps" page (work surface). Lists ALL installed apps as a
 * responsive card grid with search + sort (name A–Z / Z–A, newest / oldest by
 * installedAt). Each card launches the app or opens its detail page. Enable/
 * disable controls are available. The side-panel launcher (AppsPanel)
 * opens this via the rail `⤢ All apps` button.
 */

import { useMemo, useState } from "react";
import { X, Search } from "lucide-react";
import { useInstalledApps } from "./use-installed-apps";
import { apiClient } from "../lib/api";
import { VideoAppIcon, VideoAppPreview } from "./video-app-presentation";
import { requestOpenMiniApp } from "../adapters/open-mini-app-ref";
import { requestOpenAppDetail } from "../adapters/open-apps-surface-ref";
import {
  filterAndSortApps,
  APP_SORT_OPTIONS,
  DEFAULT_APP_SORT,
  type AppSortKey,
} from "./apps-sort";
import { AppIcon } from "./first-party-app-visuals";

export function AppsOverviewSurface({ onClose }: { onClose: () => void }) {
  const appsState = useInstalledApps();
  const reload = appsState.reload;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AppSortKey>(DEFAULT_APP_SORT);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<{ appId: string; message: string } | null>(null);

  const apps = appsState.kind === "ready" ? appsState.apps : [];
  const visible = useMemo(
    () => filterAndSortApps(appsState.kind === "ready" ? appsState.apps : [], query, sort),
    [appsState, query, sort],
  );

  return (
    <div data-testid="apps-overview" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold text-foreground">Apps</h1>
        <div className="relative min-w-[12rem] flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            data-testid="apps-overview-search"
            className="w-full rounded-md border border-border bg-background-element py-1.5 pl-7 pr-2 text-xs text-foreground outline-none focus:border-accent"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as AppSortKey)}
            aria-label="Sort apps"
            data-testid="apps-overview-sort"
            className="rounded-md border border-border bg-background-element px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
          >
            {APP_SORT_OPTIONS.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close apps"
          title="Close"
          className="ml-auto rounded-md p-1.5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {appsState.kind === "loading" ? (
          <p data-testid="apps-overview-loading" className="text-xs text-foreground-muted">
            Loading apps…
          </p>
        ) : appsState.kind === "error" ? (
          <p data-testid="apps-overview-error" className="text-xs text-foreground-muted">
            {appsState.message}
          </p>
        ) : apps.length === 0 ? (
          <p data-testid="apps-overview-empty" className="text-xs text-foreground-muted">
            No apps installed yet.
          </p>
        ) : visible.length === 0 ? (
          <p data-testid="apps-overview-no-matches" className="text-xs text-foreground-muted">
            No apps match “{query}”.
          </p>
        ) : (
          <div
            data-testid="apps-overview-grid"
            className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
          >
            {visible.map((app) => {
              const isReady = app.status === "ready";
              const isDisabled = app.enabled === false;
              const displayName = app.name?.trim() || app.id;
              const toggleEnabled = () => {
                setTogglingId(app.id);
                setToggleError(null);
                void apiClient
                  .setMiniAppEnabled(app.id, isDisabled)
                  .catch(() => setToggleError({ appId: app.id, message: "Could not update this app. Try again." }))
                  .finally(() => {
                    setTogglingId(null);
                    reload();
                  });
              };
              return (
                <div
                  key={app.id}
                  data-testid={`apps-overview-card-${app.id}`}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-background-panel p-3"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background p-1.5 text-sm text-foreground">
                      {app.id === "nautilo-video" ? <VideoAppIcon className="h-6 w-6" /> : <AppIcon appId={app.id} name={displayName} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-medium text-foreground">{displayName}</span>
                        {app.version ? (
                          <span className="shrink-0 text-[10px] text-foreground-muted">v{app.version}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {app.description?.trim() ? (
                    <p className="line-clamp-2 text-[11px] leading-snug text-foreground-muted">
                      {app.description.trim()}
                    </p>
                  ) : null}
                  {app.id === "nautilo-video" ? <VideoAppPreview /> : null}
                  <div className="flex items-center gap-1.5">
                    <span
                      className={[
                        "text-[10px]",
                        !isDisabled && isReady ? "text-[var(--success,#3fb950)]" : "text-[var(--error)]",
                      ].join(" ")}
                    >
                      {isDisabled ? "⊘ Disabled" : isReady ? "● Enabled" : "⊘ Unavailable"}
                    </span>
                    <button
                      type="button"
                      disabled={togglingId === app.id}
                      data-testid={`apps-overview-toggle-${app.id}`}
                      aria-label={isDisabled ? `Enable ${displayName}` : `Disable ${displayName}`}
                      title={isDisabled ? "Enable this app" : "Disable this app (stays installed)"}
                      onClick={toggleEnabled}
                      className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-muted hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      ⏻
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid={`apps-overview-launch-${app.id}`}
                      disabled={!isReady || isDisabled}
                      onClick={() => requestOpenMiniApp(app.id)}
                      className="rounded-md border border-border bg-background-element px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Launch
                    </button>
                    <button
                      type="button"
                      data-testid={`apps-overview-details-${app.id}`}
                      onClick={() => requestOpenAppDetail(app.id)}
                      className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
                    >
                      Details ›
                    </button>
                  </div>
                  {toggleError?.appId === app.id ? (
                    <p role="alert" className="text-[11px] text-[var(--error)]">
                      {toggleError.message}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
