/**
 * Browser column shell (D057 2a.1.1, D079 Phase 3 rename).
 *
 * Tabbed wrapper that hosts Workspace / Files. Tab visibility
 * per environment (Files is desktop-only) is decided by each tab's
 * `visible()` predicate in browser-column.tabs.ts; this component only
 * renders the tabs that pass.
 *
 * State (active tab, collapsed) lives in BrowserColumnContext so the
 * column header / keyboard shortcuts / future layout-settings UI all
 * share one source of truth. This component is pure presentation.
 *
 * DOM structure (constant irrespective of which tab is active):
 *
 *   <aside data-testid="browser-column">
 *     <div role="tablist">…</div>
 *     <div role="tabpanel">…tab content…</div>
 *   </aside>
 */

import { isDesktop } from "../../lib/desktop";
import { WorkspaceTab } from "./workspace-tab";
import { FilesTab } from "./files-tab";
import { useBrowserColumn } from "./browser-column.context";
import { BROWSER_TABS, type BrowserTabId } from "./browser-column.tabs";
import { CurrentFolderHeader } from "./current-folder-header";
import type { ActiveArtifactTarget, OpenFileTarget } from "./open-file-target";

export type { OpenFileTarget } from "./open-file-target";

/**
 * Exported so WorkbenchShell can conditionally render the column itself
 * (hide when collapsed, adjust grid-cols accordingly). The column's
 * OWN width isn't managed here — that's the grid's responsibility.
 */
interface BrowserColumnProps {
  /**
   * Called when the user clicks the collapse chevron at the end of the
   * tab bar. Shell wires this to `panelSizes.setCollapsed("browser", true)`.
   * Optional: the chevron only renders when this prop is provided, so
   * callers that don't support collapsing get a regular column.
   */
  onCollapse?: () => void;
  onOpenFile?: (target: OpenFileTarget) => void;
  onOpenFileEdit?: (target: OpenFileTarget) => void;
  activeArtifact?: ActiveArtifactTarget | null;
  onCloseActiveArtifact?: () => void;
}

export function BrowserColumn({
  onCollapse,
  onOpenFile,
  onOpenFileEdit,
  activeArtifact,
  onCloseActiveArtifact,
}: BrowserColumnProps = {}) {
  const { activeTab, setActiveTab, currentFolderPath } = useBrowserColumn();
  const envCtx = { isDesktop, currentFolderPath };
  const visibleTabs = BROWSER_TABS.filter((t) => t.visible(envCtx));

  // If somehow none are visible (shouldn't happen — workspace always
  // is on web + desktop), render nothing rather than a broken column.
  if (visibleTabs.length === 0) return null;

  // Ensure activeTab is one of the visible set (the context already
  // guards this, but belt-and-suspenders here too).
  const safeActive = visibleTabs.some((t) => t.id === activeTab)
    ? activeTab
    : visibleTabs[0].id;

  return (
    <aside
      data-testid="browser-column"
      className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-clip grid-rows-[auto_auto_1fr] border-r border-border bg-background-panel"
    >
      {/* D075 chunk 2 → D079 Phase 1 rename — current-folder header
          row: current path + dropdown with Recent / Open folder…
          Locked Layout α per the D075 Design Spec; see also native
          File → Recent Folders ▸ which reads from the same source of
          truth. */}
      <CurrentFolderHeader />

      <div role="tablist" aria-label="Browser column tabs" className="flex min-w-0 items-stretch gap-0 border-b border-border">
        {visibleTabs.map((tab) => {
          const selected = tab.id === safeActive;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`browser-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`browser-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              data-tab={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                "flex min-w-0 flex-1 items-center px-2 py-1.5 text-xs font-medium leading-5 transition-colors",
                selected
                  ? "border-b-2 border-transparent bg-background-muted text-foreground"
                  : "border-b-2 border-transparent text-foreground-muted hover:text-foreground",
              ].join(" ")}
            >
              <span className="mr-1 shrink-0" aria-hidden="true">
                {tab.glyph}
              </span>
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
        {/* D077 — collapse chevron at the right edge of the tab bar.
            Chevron points LEFT (‹) because that's the direction the
            panel moves when collapsed (off the left side of the
            viewport). Same semantic as the PanelEdgeStrip: chevron
            points toward where the panel ends up. */}
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide file browser"
            title="Hide file browser (⌘⇧B)"
            className="flex shrink-0 items-center justify-center border-b-2 border-transparent px-2 py-1.5 text-sm leading-5 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground transition-colors"
          >
            <span aria-hidden="true">‹</span>
          </button>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id={`browser-panel-${safeActive}`}
        aria-labelledby={`browser-tab-${safeActive}`}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <TabBody
          id={safeActive}
          onOpenFile={onOpenFile}
          onOpenFileEdit={onOpenFileEdit}
          activeArtifact={activeArtifact}
          onCloseActiveArtifact={onCloseActiveArtifact}
        />
      </div>
    </aside>
  );
}

function TabBody({
  id,
  onOpenFile,
  onOpenFileEdit,
  activeArtifact,
  onCloseActiveArtifact,
}: {
  id: BrowserTabId;
  onOpenFile?: (target: OpenFileTarget) => void;
  onOpenFileEdit?: (target: OpenFileTarget) => void;
  activeArtifact?: ActiveArtifactTarget | null;
  onCloseActiveArtifact?: () => void;
}) {
  // Could be a switch expression, but explicit cases document intent.
  if (id === "workspace") {
    return (
      <WorkspaceTab
        onOpenFile={onOpenFile}
        onOpenFileEdit={onOpenFileEdit}
        activeArtifact={activeArtifact}
        onCloseActiveArtifact={onCloseActiveArtifact}
      />
    );
  }
  return <FilesTab onOpenFile={onOpenFile} onOpenFileEdit={onOpenFileEdit} />;
}
