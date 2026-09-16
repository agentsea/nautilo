import { useCallback, useEffect, useRef, useState } from "react";
import { createWorkbenchPortal as createPortal } from "../../../../components/workbench-portals";
import { ArrowDown, ArrowDownUp, ArrowUp, Check } from "lucide-react";
import type { ExplorerSortDir, ExplorerSortMode } from "../explorer-grouping.types";
import { useExplorerSort } from "../hooks/useExplorerSort";

export function ExplorerSortControl() {
  const { sort, setMode, setDir } = useExplorerSort();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  const recomputeMenuPos = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenuPos({
      top: Math.round(r.bottom + 4),
      right: Math.round(Math.max(8, window.innerWidth - r.right)),
    });
  }, []);

  const toggleMenu = useCallback(() => {
    setMenuOpen((prev) => {
      if (!prev) recomputeMenuPos();
      return !prev;
    });
  }, [recomputeMenuPos]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node;
      const inTrigger = btnRef.current?.contains(target) ?? false;
      const inMenu = menuRef.current?.contains(target) ?? false;
      if (!inTrigger && !inMenu) setMenuOpen(false);
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === "Escape") setMenuOpen(false);
    };
    const onReflow = () => recomputeMenuPos();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [menuOpen, recomputeMenuPos]);

  const chooseMode = (mode: ExplorerSortMode) => {
    setMode(mode);
  };
  const chooseDir = (dir: ExplorerSortDir) => {
    setDir(dir);
  };

  const modeLabel = sort.mode === "alpha" ? "A–Z" : "Recent";

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Sort rooms (${modeLabel}, ${sort.dir === "asc" ? "ascending" : "descending"})`}
        title={`Sort: ${modeLabel}`}
        className="rounded-md p-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
      >
        <ArrowDownUp aria-hidden="true" size={14} />
      </button>
      {menuOpen && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Sort rooms"
              style={{ position: "fixed", top: menuPos.top, right: menuPos.right }}
              className="z-50 w-44 rounded-md border border-border bg-background-panel py-1 shadow-lg"
            >
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-dim">
                Sort by
              </div>
              {(
                [
                  ["recent", "Recent"],
                  ["alpha", "A–Z"],
                ] as ReadonlyArray<[ExplorerSortMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort.mode === mode}
                  onClick={() => chooseMode(mode)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--primary-muted)]"
                >
                  <Check
                    aria-hidden="true"
                    size={12}
                    className={`shrink-0 ${sort.mode === mode ? "text-accent" : "invisible"}`}
                  />
                  {label}
                </button>
              ))}

              <div className="mx-2 my-1 border-t border-border/60" />

              {(
                [
                  ["asc", "Ascending", ArrowUp],
                  ["desc", "Descending", ArrowDown],
                ] as ReadonlyArray<[ExplorerSortDir, string, typeof ArrowUp]>
              ).map(([dir, label, Icon]) => (
                <button
                  key={dir}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort.dir === dir}
                  onClick={() => chooseDir(dir)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--primary-muted)]"
                >
                  <Check
                    aria-hidden="true"
                    size={12}
                    className={`shrink-0 ${sort.dir === dir ? "text-accent" : "invisible"}`}
                  />
                  <Icon aria-hidden="true" size={12} className="shrink-0 text-foreground-muted" />
                  {label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
