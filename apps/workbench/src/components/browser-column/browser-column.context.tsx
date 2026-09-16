/**
 * Browser column context (D057 2a.1.2, D079 Phase 1 rename).
 *
 * Owns:
 *   - currentFolderPath — the user's task-scoped folder (Surface B per
 *     D079). Resolved at mount via desktopAPI.currentFolder.getPath()
 *     + live updates via desktopAPI.currentFolder.onPathChanged (D075
 *     chunk 2) so tray-initiated folder swaps land in the context
 *     without a page reload.
 *   - activeTab — current visible tab, persisted in localStorage.
 *
 * Deliberately DOES NOT own:
 *   - browser-column collapsed state — migrated to `usePanelSizes` in
 *     D077 so all panel geometry (browser/context widths + both
 *     collapse flags) lives in one source of truth.
 *   - Genie's Workspace path (Surface A) — lands in D079 Phase 3 as a
 *     separate top-level context (workspace is app-wide, current
 *     folder is browser-column-local).
 *
 * Deferred to a follow-up (per 2a.1 scope):
 *   - ⌘1 / ⌘2 / ⌘3 tab switching
 *   - desktopAPI.config cross-window mirroring
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isDesktop, desktopAPI } from "../../lib/desktop";
import { setCurrentFolder as publishCurrentFolder } from "../../adapters/file-context-ref";
import { BROWSER_TABS, firstVisibleTab, type BrowserTabId } from "./browser-column.tabs";

const LS_ACTIVE_TAB = "nautilo.browser.activeTab";

interface BrowserColumnContextValue {
  /**
   * Absolute path to the current folder (Surface B — the task-scoped
   * folder the user pointed Nautilo at), or null if no folder is
   * open. Null is a legitimate state post-D079 Phase 1: fresh installs
   * have no default, and the Files tab renders an empty-state picker.
   */
  currentFolderPath: string | null;
  /**
   * Called by the CurrentFolderHeader dropdown after a successful
   * commit (setPath / pickAndCommit). Updates context so Files tab
   * re-reads without a page reload.
   */
  setCurrentFolderPath: (p: string | null) => void;
  /** Currently visible tab. Always resolves to a tab that passes its
   *  visibility predicate for the current environment. */
  activeTab: BrowserTabId;
  setActiveTab: (id: BrowserTabId) => void;
}

const BrowserColumnContext = createContext<BrowserColumnContextValue | null>(null);

export function useBrowserColumn(): BrowserColumnContextValue {
  const ctx = useContext(BrowserColumnContext);
  if (!ctx) {
    throw new Error("useBrowserColumn must be used within <BrowserColumnProvider>");
  }
  return ctx;
}

function readStoredTab(): BrowserTabId | null {
  try {
    const raw = localStorage.getItem(LS_ACTIVE_TAB);
    if (raw === "workspace" || raw === "files") return raw;
    // D106 — Activity tab removed; migrate persisted selection.
    if (raw === "activity") return "workspace";
    // D342 — Apps tab removed (promoted to a dedicated rail panel); migrate
    // persisted "apps" selections to Workspace (same leftmost slot).
    if (raw === "apps") return "workspace";
    // D079 Phase 3 — one-shot migration. Users who had the legacy
    // "artifacts" tab active land on the new "workspace" tab (same
    // position in the tab bar, renamed). Future reads will pick up
    // the migrated value since `setActiveTab` writes the new id.
    if (raw === "artifacts") return "workspace";
    return null;
  } catch {
    return null;
  }
}

export function BrowserColumnProvider({ children }: { children: ReactNode }) {
  const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(null);
  const [currentFolderRelayId, setCurrentFolderRelayId] = useState<string | null>(null);
  // Seed activeTab from localStorage; validate against current env in
  // an effect once currentFolderPath is known (so the Files fallback
  // is honored).
  const [activeTab, setActiveTabRaw] = useState<BrowserTabId>(() => {
    const stored = readStoredTab();
    if (stored) return stored;
    // On initial mount, pre-hydration, guess based on whether we're in
    // Electron. Refined below once currentFolderPath resolves.
    return firstVisibleTab({ isDesktop, currentFolderPath: null });
  });

  // Resolve currentFolderPath from desktopAPI on mount. Post-D079
  // Phase 1 the main-process boot flow LEAVES this null when no
  // persisted value exists (previously auto-created
  // ~/Documents/Nautilo; that logic moved to Phase 3 as the Workspace
  // default). Null is a legitimate state the Files tab handles with
  // an empty-state picker.
  useEffect(() => {
    if (!isDesktop || !desktopAPI) return;
    let cancelled = false;
    void (desktopAPI.currentFolder.getContext
      ? desktopAPI.currentFolder.getContext()
      : desktopAPI.currentFolder.getPath().then((currentFolder) => ({ currentFolder, relayId: null }))
    ).then((context) => {
      if (!cancelled) {
        setCurrentFolderPath(context.currentFolder);
        setCurrentFolderRelayId(context.relayId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // D075 chunk 2 — subscribe to main-process push events when the
  // current folder changes via the tray, the native File menu's Recent
  // Folders submenu, or any future main-side commit path. Dropdown
  // commits come through the renderer and use setCurrentFolderPath
  // directly, so this handler covers the "external commit" case only.
  useEffect(() => {
    if (!isDesktop || !desktopAPI) return;
    return desktopAPI.currentFolder.onPathChanged((p) => {
      setCurrentFolderPath(p);
    });
  }, []);

  // D079 Phase 2 — publish the current folder path to the module-
  // level ref that NautiloRuntimeProvider's sendText reads from.
  // The runtime provider is a PARENT of this provider in the tree,
  // so it can't call useBrowserColumn() directly; the ref bridges
  // the gap. Fires on every change (including the initial resolve
  // from desktopAPI + any later swaps via dropdown or push events),
  // so the next outgoing message always carries the current value.
  // See `adapters/file-context-ref.ts` for the rationale.
  useEffect(() => {
    publishCurrentFolder(currentFolderPath, currentFolderRelayId);
  }, [currentFolderPath, currentFolderRelayId]);

  // Revalidate activeTab once we know the currentFolderPath — if the
  // stored tab is no longer visible (e.g. user previously had a folder
  // open, now doesn't), fall back to the first visible tab.
  useEffect(() => {
    const ctx = { isDesktop, currentFolderPath };
    const currentTab = BROWSER_TABS.find((t) => t.id === activeTab);
    if (currentTab && !currentTab.visible(ctx)) {
      setActiveTabRaw(firstVisibleTab(ctx));
    }
    // Intentional: only re-check on currentFolderPath change. activeTab
    // changes that pass visibility are user intent and shouldn't
    // re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderPath]);

  const setActiveTab = useCallback((id: BrowserTabId) => {
    setActiveTabRaw(id);
    try {
      localStorage.setItem(LS_ACTIVE_TAB, id);
    } catch {
      /* noop — non-fatal */
    }
  }, []);

  const value = useMemo<BrowserColumnContextValue>(
    () => ({
      currentFolderPath,
      setCurrentFolderPath,
      activeTab,
      setActiveTab,
    }),
    [currentFolderPath, activeTab, setActiveTab],
  );

  return (
    <BrowserColumnContext.Provider value={value}>{children}</BrowserColumnContext.Provider>
  );
}
