import { useState } from "react";
import { Search } from "lucide-react";
import { useInstalledApps } from "./use-installed-apps";
import { filterAndSortApps, DEFAULT_APP_SORT } from "./apps-sort";
import { AppIcon } from "./first-party-app-visuals";
import { requestOpenAppDetail } from "../adapters/open-apps-surface-ref";

/** Search installed apps without leaving the current app's details. */
export function AppDetailSearch() {
  const state = useInstalledApps();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const matches = filterAndSortApps(state.kind === "ready" ? state.apps : [], query, DEFAULT_APP_SORT);
  const showResults = open && query.trim().length > 0;
  const select = (appId: string) => {
    setQuery("");
    setOpen(false);
    requestOpenAppDetail(appId);
  };

  return (
    <div
      className="relative ml-auto min-w-0 max-w-sm flex-1"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
        <input
          type="search"
          aria-label="Search apps"
          placeholder="Search apps…"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && showResults && matches[0]) {
              event.preventDefault();
              select(matches[0].id);
            }
          }}
          className="w-full rounded-lg border border-border bg-background-element py-1.5 pl-8 pr-2 text-xs text-foreground placeholder:text-foreground-muted outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        />
      </div>
      {showResults ? (
        <nav aria-label="App search results" className="absolute right-0 top-full z-20 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-background p-1 shadow-lg">
          {state.kind === "loading" ? (
            <p role="status" className="px-3 py-2 text-xs text-foreground-muted">Loading apps…</p>
          ) : state.kind === "error" ? (
            <div className="px-3 py-2 text-xs text-foreground-muted">
              <p role="status">Could not load apps.</p>
              <button type="button" onClick={state.reload} className="mt-1 underline">Try again</button>
            </div>
          ) : matches.length === 0 ? (
            <p role="status" className="px-3 py-2 text-xs text-foreground-muted">No apps match “{query}”.</p>
          ) : (
            <>
              <p role="status" className="px-3 py-1 text-[11px] text-foreground-muted">{matches.length} {matches.length === 1 ? "app" : "apps"} found</p>
              {matches.map((app) => (
                <button key={app.id} type="button" onClick={() => select(app.id)} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-[var(--primary-muted)] focus-visible:bg-[var(--primary-muted)] focus-visible:outline-none">
                  <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center"><AppIcon appId={app.id} name={app.name?.trim() || app.id} /></span>
                  <span className="min-w-0 flex-1 truncate">{app.name?.trim() || app.id}</span>
                  {app.enabled === false ? <span className="text-[10px] text-foreground-muted">Disabled</span> : null}
                </button>
              ))}
            </>
          )}
        </nav>
      ) : null}
    </div>
  );
}
