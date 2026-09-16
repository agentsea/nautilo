/**
 * CurrentFolderHeader — top row of the browser column.
 *
 * (D079 Phase 1 rename of the original WorkspaceHeader from D075
 * chunk 2. Surface B per D079 vocabulary: the user's task-scoped
 * folder — a codebase, a design dump, legal PDFs, etc.)
 *
 * Layout α, row 1 (per the D075 Design Spec):
 *
 *   ┌────────────────────────────┐
 *   │ 📂 my-codebase          ▾ │  ← this component
 *   ├────────────────────────────┤
 *   │ 🔍 Search files…      🙈 │
 *   ├────────────────────────────┤
 *   │ ◆ Artifacts │ Files │ ◌ ‹│
 *   ├────────────────────────────┤
 *   │ tree…                      │
 *
 * Clicking opens a popover dropdown with:
 *   - CURRENT: the currently-open folder (highlighted, not clickable)
 *   - RECENT: last 5 folders (via desktopAPI.currentFolder.listRecent);
 *     each clickable, commits via setPath.
 *   - Divider
 *   - 📁 Open folder… → desktopAPI.currentFolder.pickAndCommit
 *
 * (D079 Phase 1 removed the "Use default workspace" action — current
 * folder has no default in the D079 model. Phase 3 will add a
 * sibling Workspace action when the Workspace surface lands.)
 *
 * Render decisions:
 *   - Keeps folder chrome in the column (not the workbench header)
 *     so it's mode-aware (visible in Modes A/B, not in C/D).
 *   - Closes on click-outside + Escape. No modal — just a popover.
 *   - Shows folder basename (truncated to column width) with title
 *     tooltip revealing full path. Falls back to "no folder open"
 *     when `currentFolderPath` is null.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChevronDown, Folder, FolderOpen, FolderPlus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { desktopAPI, isDesktop } from "../../lib/desktop";
import { useBrowserColumn } from "./browser-column.context";

type DesktopFilesystemAccessStatus =
  | { state: "loading" }
  | { state: "available"; activeGrantCount: number }
  | { state: "unavailable" }
  | { state: "unknown" };

function basename(p: string | null): string {
  if (!p) return "no folder open";
  // POSIX + Windows-safe last-segment extraction.
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || p;
}

export function CurrentFolderHeader({
  isDesktopShell = isDesktop,
}: {
  /** Injectable for desktop-shell boundary tests. */
  isDesktopShell?: boolean;
} = {}) {
  const { currentFolderPath, setCurrentFolderPath } = useBrowserColumn();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [desktopFilesystemAccess, setDesktopFilesystemAccess] = useState<DesktopFilesystemAccessStatus>({
    state: "loading",
  });
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch recent list every time the popover opens — cheap and keeps
  // the list live against external commits (native menu / tray) without
  // needing a separate subscription.
  useEffect(() => {
    if (!open || !isDesktopShell || !desktopAPI) return;
    let cancelled = false;
    void desktopAPI.currentFolder.listRecent().then((list) => {
      if (!cancelled) setRecent(list);
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktopShell, open]);

  // This is status-only: the Files header may show the number of active
  // guarded locations, but management remains in Settings.
  useEffect(() => {
    if (!open || !isDesktopShell) return;
    const grantsApi = desktopAPI?.desktopFilesystemGrants;
    if (!grantsApi) {
      setDesktopFilesystemAccess({ state: "unavailable" });
      return;
    }

    let cancelled = false;
    setDesktopFilesystemAccess({ state: "loading" });
    void grantsApi.list().then(
      (result) => {
        if (cancelled) return;
        if (!result.ok) {
          setDesktopFilesystemAccess({ state: "unknown" });
          return;
        }
        setDesktopFilesystemAccess({
          state: "available",
          activeGrantCount: result.data.grants.filter((item) => item.status === "active").length,
        });
      },
      () => {
        if (!cancelled) setDesktopFilesystemAccess({ state: "unknown" });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [isDesktopShell, open]);

  // Click-outside and Escape close the popover. Attached while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commitRecent = useCallback(
    async (p: string) => {
      if (!desktopAPI) return;
      try {
        await desktopAPI.currentFolder.setPath(p);
        setCurrentFolderPath(p);
        setOpen(false);
      } catch (err) {
        console.warn("[current-folder-header] commit recent failed:", err);
      }
    },
    [setCurrentFolderPath],
  );

  const openFolder = useCallback(async () => {
    if (!desktopAPI) return;
    try {
      const picked = await desktopAPI.currentFolder.pickAndCommit();
      if (picked) setCurrentFolderPath(picked);
    } catch (err) {
      console.warn("[current-folder-header] pick failed:", err);
    } finally {
      setOpen(false);
    }
  }, [setCurrentFolderPath]);

  const manageDesktopFilesystemAccess = useCallback(() => {
    setOpen(false);
    void navigate("/settings");
  }, [navigate]);

  // Only render on desktop. Web builds don't have a current-folder
  // concept (no filesystem access).
  if (!isDesktopShell) return null;

  const label = basename(currentFolderPath);
  const recentOthers = recent.filter((p) => p !== currentFolderPath);

  return (
    <div ref={containerRef} className="relative flex items-center border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={currentFolderPath ?? "no folder open"}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-[var(--primary-muted)] transition-colors"
      >
        <FolderOpen
          aria-hidden="true"
          size={14}
          className="shrink-0 text-foreground-muted"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          aria-hidden="true"
          size={14}
          className={`shrink-0 text-foreground-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {/* D303 — one-click "Open folder" directly in the Files panel header
          (the chevron above still opens the Recent/Open-folder menu). */}
      <button
        type="button"
        onClick={() => void openFolder()}
        aria-label="Open folder…"
        title="Open folder…"
        className="mr-1.5 flex shrink-0 items-center justify-center rounded px-1.5 py-1 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground transition-colors"
      >
        <FolderPlus aria-hidden="true" size={14} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Current folder"
          className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-border bg-background-panel py-1 shadow-lg"
        >
          {/* CURRENT */}
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-dim">
            Current
          </div>
          <div className="px-3 py-1.5 text-xs text-foreground">
            <div className="truncate" title={currentFolderPath ?? ""}>
              {currentFolderPath ?? "(none)"}
            </div>
          </div>

          {/* RECENT (only if there's anything besides the current) */}
          {recentOthers.length > 0 ? (
            <>
              <div className="mx-2 my-1 border-t border-border/60" />
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-dim">
                Recent
              </div>
              {recentOthers.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="menuitem"
                  onClick={() => void commitRecent(p)}
                  title={p}
                  className="block w-full truncate px-3 py-1.5 text-left text-xs text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground transition-colors"
                >
                  {p}
                </button>
              ))}
            </>
          ) : null}

          <div className="mx-2 my-1 border-t border-border/60" />

          {/* Actions */}
          <button
            type="button"
            role="menuitem"
            onClick={manageDesktopFilesystemAccess}
            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)] transition-colors"
          >
            <span>Desktop file access</span>
            <span className="text-foreground-muted">
              {desktopFilesystemAccess.state === "loading"
                ? "Checking…"
                : desktopFilesystemAccess.state === "available"
                  ? `${desktopFilesystemAccess.activeGrantCount} active`
                  : desktopFilesystemAccess.state === "unavailable"
                    ? "Unavailable"
                    : "Status unknown"}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={manageDesktopFilesystemAccess}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)] transition-colors"
          >
            <span>Manage access…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void openFolder()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)] transition-colors"
          >
            <Folder aria-hidden="true" size={12} className="shrink-0 text-foreground-muted" />
            <span>Open folder…</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
