/**
 * Tab metadata for the Browser column (D057 2a.1.1, D079 Phase 3 rename).
 *
 * Exporting as data (not JSX) keeps this file dependency-free so both
 * the context + the render component can import it without circles.
 * Visibility predicates run at render time against the workbench
 * environment (isDesktop + currentFolderPath) — the "shared component,
 * one tree" principle: browser (web) shows fewer tabs, desktop shows
 * all.
 *
 * D079 Phase 3 renamed the `artifacts` tab to `workspace`. The old id
 * is preserved in localStorage via a one-shot migration in
 * `readStoredTab()` so users who had Artifacts as their active tab
 * land on Workspace post-upgrade.
 *
 * D106 Phase 4 — removed the Activity tab from primary navigation (tool
 * feed had low signal vs Workspace / Files).
 *
 * D342 — removed the Apps tab. Installed mini-apps were promoted out of this
 * column into a dedicated left-rail panel (`<AppsPanel />`, browserMode
 * "apps"); the column reverts to Workspace / Files. Persisted "apps" selections
 * migrate to "workspace" in `readStoredTab()`.
 */

export type BrowserTabId = "workspace" | "files";

export interface BrowserTab {
  id: BrowserTabId;
  label: string;
  /**
   * Glyph used in the tab header. Not a full icon component — we keep
   * it to a single character so it renders consistently across themes
   * without pulling in the lucide icon pipeline for one column.
   */
  glyph: string;
  /**
   * Visibility predicate. `files` is gated on desktop + an open current
   * folder (per D079 Phase 1 rename); `workspace` always shows on web and desktop.
   */
  visible: (ctx: { isDesktop: boolean; currentFolderPath: string | null }) => boolean;
  /** Search-bar placeholder for this tab. */
  searchPlaceholder: string;
}

export const BROWSER_TABS: BrowserTab[] = [
  {
    // D079 Phase 3 — Genie's Workspace tab. Leftmost because it's
    // always valid (default root always exists); Files tab may be
    // empty if the user hasn't opened a folder.
    id: "workspace",
    label: "Workspace",
    glyph: "⋆",
    visible: () => true,
    searchPlaceholder: "Search workspace…",
  },
  {
    id: "files",
    label: "Files",
    glyph: "▸",
    // Files tab surfaces whenever we're on desktop — even if no folder
    // is open, because the tab needs to be reachable so the user can
    // open one via its empty state. Pre-D079 the predicate also
    // required a workspace to be set; that meant fresh installs never
    // saw the tab. New behavior: desktop-only, always reachable; the
    // tab body renders the empty-state picker when no folder is open.
    visible: (ctx) => ctx.isDesktop,
    searchPlaceholder: "Search files…",
  },
];

/**
 * Pick the first tab that should be visible given the environment.
 * Used as the fallback when a persisted activeTab is no longer visible
 * (e.g. desktop build that later opens on web — files tab gone).
 */
export function firstVisibleTab(ctx: {
  isDesktop: boolean;
  currentFolderPath: string | null;
}): BrowserTabId {
  const found = BROWSER_TABS.find((t) => t.visible(ctx));
  return found?.id ?? "workspace";
}
