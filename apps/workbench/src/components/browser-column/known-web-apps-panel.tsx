import { History, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { requestOpenSaasApp } from "../../adapters/open-saas-app-ref";
import { requestWebsiteConnection } from "../../adapters/website-connection-intent";
import { useAuth } from "../../hooks/use-auth";
import { searchWebsiteCatalogue } from "../../lib/website-catalogue";
import { stableViewerKeyForStorage } from "../../rooms/room-navigation-storage";
import { CollapsibleSection } from "../collapsible-section";
import {
  clearHistory,
  getHistory,
  getPinnedSites,
  removePinnedSite,
  subscribeWebPrefs,
  type HistoryEntry,
  type PinnedSite,
} from "../../lib/web-prefs";

const GOOGLE_SUITE_STORAGE_PREFIX = "nautilo.known-web-apps.google-suite.expanded.v1";
const HISTORY_STORAGE_PREFIX = "nautilo.known-web-apps.history.expanded.v1";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function googleSuiteStorageKey(viewerKey: string | null): string | null {
  return viewerKey ? `${GOOGLE_SUITE_STORAGE_PREFIX}:${viewerKey}` : null;
}

function historyStorageKey(viewerKey: string | null): string | null {
  return viewerKey ? `${HISTORY_STORAGE_PREFIX}:${viewerKey}` : null;
}

const KNOWN_WEB_APPS = [
  {
    appId: "google-docs",
    displayName: "Google Docs",
    initialUrl: "https://docs.google.com/document/u/0/",
    skills: ["write", "read", "new doc"],
    status: "experimental" as const,
  },
  {
    appId: "google-sheets",
    displayName: "Google Sheets",
    initialUrl: "https://docs.google.com/spreadsheets/u/0/",
    skills: ["spreadsheets", "sheets", "tables"],
    status: "experimental" as const,
  },
  {
    appId: "google-slides",
    displayName: "Google Slides",
    initialUrl: "https://docs.google.com/presentation/u/0/",
    skills: ["presentations", "slides", "deck"],
    status: "experimental" as const,
  },
  {
    appId: "google-calendar",
    displayName: "Google Calendar",
    initialUrl: "https://calendar.google.com/calendar/u/0/r",
    skills: ["events", "schedule", "calendar"],
    status: "experimental" as const,
  },
  {
    appId: "gmail",
    displayName: "Gmail",
    initialUrl: "https://mail.google.com/mail/u/0/#inbox",
    skills: ["email", "drafts", "search"],
    status: "experimental" as const,
  },
  {
    appId: "google-drive",
    displayName: "Google Drive",
    initialUrl: "https://drive.google.com/drive/u/0/my-drive",
    skills: ["files", "search", "sharing"],
    status: "experimental" as const,
  },
] as const;

export function KnownWebAppsPanel({ onCollapse }: { onCollapse: () => void }) {
  const auth = useAuth();
  const viewerKey = stableViewerKeyForStorage(auth.viewer);
  const storageKey = googleSuiteStorageKey(viewerKey);
  const historyKey = historyStorageKey(viewerKey);
  const [query, setQuery] = useState("");
  const [pinnedSites, setPinnedSites] = useState<PinnedSite[]>(() =>
    getPinnedSites(viewerKey),
  );
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>(() =>
    getHistory(viewerKey),
  );
  const hasQuery = query.trim().length > 0;
  const filteredGoogleApps = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return KNOWN_WEB_APPS;
    return KNOWN_WEB_APPS.filter((app) =>
      `${app.displayName} ${app.skills.join(" ")}`.toLowerCase().includes(q)
    );
  }, [query]);
  const filteredWebsites = useMemo(() => searchWebsiteCatalogue(query), [query]);

  useEffect(() => {
    const refresh = () => {
      setPinnedSites(getPinnedSites(viewerKey));
      setHistoryEntries(getHistory(viewerKey));
    };
    refresh();
    return subscribeWebPrefs(refresh);
  }, [viewerKey]);

  return (
    <aside
      data-testid="known-web-apps-panel"
      className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-clip grid-rows-[auto_1fr] border-r border-border bg-background-panel"
    >
      <header className="border-b border-border px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Web
          </div>
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide web"
            title="Hide web"
            className="rounded px-1.5 py-0.5 text-sm text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
          >
            ‹
          </button>
        </div>
        <label className="flex items-center gap-2 rounded-md border border-border bg-background-element px-2 py-1.5">
          <Search aria-hidden="true" className="h-3.5 w-3.5 text-foreground-muted" />
          <input
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search apps…"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-muted"
          />
        </label>
        <div className="mt-2 grid gap-1">
          <button
            type="button"
            onClick={() =>
              requestOpenSaasApp({
                appId: "browser",
                displayName: "Browser",
                initialUrl: "https://duckduckgo.com",
                mode: "browser",
              })
            }
            className="rounded-md border border-border bg-background-element px-2 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)]"
          >
            🌐 Open browser…
          </button>
          <button
            type="button"
            onClick={() => requestWebsiteConnection({ kind: "custom", url: "" })}
            className="rounded-md border border-border bg-background-element px-2 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)]"
          >
            ＋ Add an app
          </button>
        </div>
      </header>
      <div className="min-h-0 overflow-y-auto px-3 py-2">
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            <Star aria-hidden="true" className="h-3 w-3" />
            Pinned
          </div>
          {pinnedSites.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-foreground-muted">
              No pinned sites yet — ⭐ a page in the browser to pin it.
            </div>
          ) : (
            <div className="space-y-1">
              {pinnedSites.map((site) => (
                <div
                  key={site.url}
                  className="flex items-center gap-1 rounded-md border border-border bg-background-element hover:bg-[var(--primary-muted)]"
                >
                  <button
                    type="button"
                    data-testid={`known-web-apps-pinned-${site.appId}`}
                    onClick={() =>
                      requestOpenSaasApp({
                        appId: site.appId,
                        displayName: site.displayName,
                        initialUrl: site.url,
                        mode: site.mode ?? "browser",
                      })
                    }
                    className="min-w-0 flex-1 px-2 py-1.5 text-left"
                  >
                    <div className="truncate text-xs font-medium text-foreground">
                      {site.displayName}
                    </div>
                    <div className="truncate text-[10px] text-foreground-muted">
                      {hostOf(site.url)}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Unpin ${site.displayName}`}
                    title={`Unpin ${site.displayName}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      removePinnedSite(viewerKey, site.url);
                    }}
                    className="mr-1 rounded p-1 text-foreground-muted hover:bg-muted hover:text-foreground"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <CollapsibleSection
          title="Google Suite"
          count={filteredGoogleApps.length}
          storageKey={storageKey}
          defaultExpanded
          forceExpanded={hasQuery}
          testId="known-web-apps-google-suite"
        >
          <div className="space-y-1 pl-3">
            {filteredGoogleApps.map((app) => (
              <button
                key={app.appId}
                type="button"
                data-testid={`known-web-app-${app.appId}`}
                onClick={() => requestOpenSaasApp(app)}
                className="w-full rounded-md border border-border bg-background-element px-2 py-2 text-left transition-colors hover:bg-[var(--primary-muted)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">📄 {app.displayName}</span>
                  <span className="text-[10px] text-foreground-muted">◐</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-foreground-muted">
                  <span className="rounded bg-background-panel px-1 py-0.5">API</span>
                  <span className="rounded bg-background-panel px-1 py-0.5">Browser</span>
                  <span>{app.skills.join(" · ")}</span>
                </div>
              </button>
            ))}
          </div>
        </CollapsibleSection>
        <CollapsibleSection
          title="Websites"
          count={filteredWebsites.length}
          defaultExpanded
          forceExpanded={hasQuery}
          testId="known-web-apps-websites"
        >
          <div className="space-y-1 pl-3">
            {filteredWebsites.map((website) => (
              <button
                key={website.id}
                type="button"
                data-testid={`known-web-website-${website.id}`}
                onClick={() => requestWebsiteConnection({ kind: "catalogue", websiteId: website.id })}
                className="w-full rounded-md border border-border bg-background-element px-2 py-2 text-left transition-colors hover:bg-[var(--primary-muted)]"
              >
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center rounded bg-background-panel text-[9px] font-semibold">{website.icon}</span>
                  <span className="text-xs font-medium text-foreground">{website.displayName}</span>
                </div>
                <div className="mt-1 text-[10px] capitalize text-foreground-muted">{website.category}</div>
              </button>
            ))}
            {hasQuery && filteredWebsites.length === 0 ? <p className="px-1 py-1 text-[11px] text-foreground-muted">No websites match that search.</p> : null}
          </div>
        </CollapsibleSection>
        <CollapsibleSection
          title="History"
          count={historyEntries.length}
          storageKey={historyKey}
          defaultExpanded={false}
          icon={<History aria-hidden="true" className="h-3 w-3" />}
          testId="known-web-apps-history"
        >
          <div className="mb-1 flex justify-end px-1">
            {historyEntries.length > 0 ? (
              <button
                type="button"
                aria-label="Clear history"
                title="Clear history"
                onClick={() => clearHistory(viewerKey)}
                className="rounded px-1.5 py-0.5 text-[10px] text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
              >
                Clear
              </button>
            ) : null}
          </div>
          {historyEntries.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-foreground-muted">
              No history yet — pages you visit in the browser will show here.
            </div>
          ) : (
            <div className="space-y-1">
              {historyEntries.map((entry, index) => (
                <button
                  key={`${index}-${entry.url}`}
                  type="button"
                  data-testid={`known-web-apps-history-${index}`}
                  onClick={() =>
                    requestOpenSaasApp({
                      appId: "browser",
                      displayName: entry.title || entry.url,
                      initialUrl: entry.url,
                      mode: "browser",
                    })
                  }
                  className="w-full rounded-md border border-border bg-background-element px-2 py-1.5 text-left hover:bg-[var(--primary-muted)]"
                >
                  <div className="truncate text-xs text-foreground">
                    {entry.title || entry.url}
                  </div>
                </button>
              ))}
            </div>
          )}
        </CollapsibleSection>
        <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
          ▸ Experimental
        </div>
      </div>
    </aside>
  );
}
