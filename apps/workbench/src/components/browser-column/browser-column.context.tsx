/**
 * Owns the current folder and visible browser tab. Folder selections come from
 * Desktop and reach message submission synchronously; the visible tab persists
 * in localStorage. Panel geometry and the app-wide Genie Workspace have their
 * own providers.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
   * open. Null is a legitimate state for fresh installs: they
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
    // Activity tab removed; migrate persisted selection.
    if (raw === "activity") return "workspace";
    // Apps tab removed (promoted to a dedicated rail panel); migrate
    // persisted "apps" selections to Workspace (same leftmost slot).
    if (raw === "apps") return "workspace";
    // one-shot migration. Users who had the legacy
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
  const [currentFolderPath, setCurrentFolderPathRaw] = useState<string | null>(null);
  const folder = useRef({ path: null as string | null, relayId: null as string | null, revision: 0 });
  const setCurrentFolderPath = useCallback((path: string | null) => {
    folder.current.path = path;
    folder.current.revision += 1;
    // Message submission reads this projection synchronously. Publishing in a
    // passive effect leaves a window in which a new message uses the old root.
    publishCurrentFolder(path, folder.current.relayId);
    setCurrentFolderPathRaw(path);
  }, []);
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

  useEffect(() => {
    if (!isDesktop || !desktopAPI) return;
    let cancelled = false;
    // Subscribe before reading so a native commit cannot be lost during IPC.
    const unsubscribe = desktopAPI.currentFolder.onPathChanged(setCurrentFolderPath);
    const revision = folder.current.revision;
    publishCurrentFolder(folder.current.path, folder.current.relayId);
    void (desktopAPI.currentFolder.getContext
      ? desktopAPI.currentFolder.getContext()
      : desktopAPI.currentFolder.getPath().then((currentFolder) => ({ currentFolder, relayId: null }))
    ).then((context) => {
      if (cancelled) return;
      // Relay identity is persisted by Desktop and does not change with folder
      // selection. Keep it even if this read's folder has already been replaced.
      folder.current.relayId = context.relayId;
      if (folder.current.revision === revision) {
        setCurrentFolderPath(context.currentFolder);
      } else {
        publishCurrentFolder(folder.current.path, folder.current.relayId);
      }
    }).catch(() => {
      // A failed initial read cannot clear a newer successful native selection.
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setCurrentFolderPath]);

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
    [currentFolderPath, setCurrentFolderPath, activeTab, setActiveTab],
  );

  return (
    <BrowserColumnContext.Provider value={value}>{children}</BrowserColumnContext.Provider>
  );
}
