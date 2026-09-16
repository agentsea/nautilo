import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_EXPLORER_SORT,
  type ExplorerSortDir,
  type ExplorerSortMode,
  type ExplorerSortSettings,
} from "../explorer-grouping.types";

const STORAGE_KEY = "nautilo.workbench.explorer.sort.v1";
const SCHEMA_VERSION = 1;

interface StoredSortState {
  v: number;
  mode: ExplorerSortMode;
  dir: ExplorerSortDir;
}

function isSortMode(value: unknown): value is ExplorerSortMode {
  return value === "recent" || value === "alpha";
}

function isSortDir(value: unknown): value is ExplorerSortDir {
  return value === "asc" || value === "desc";
}

function readStoredSort(): ExplorerSortSettings {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return DEFAULT_EXPLORER_SORT;
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_EXPLORER_SORT;

    const parsed = JSON.parse(raw) as Partial<StoredSortState>;
    if (parsed.v !== SCHEMA_VERSION) return DEFAULT_EXPLORER_SORT;

    return {
      mode: isSortMode(parsed.mode) ? parsed.mode : DEFAULT_EXPLORER_SORT.mode,
      dir: isSortDir(parsed.dir) ? parsed.dir : DEFAULT_EXPLORER_SORT.dir,
    };
  } catch {
    return DEFAULT_EXPLORER_SORT;
  }
}

function writeStoredSort(state: ExplorerSortSettings): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const payload: StoredSortState = {
      v: SCHEMA_VERSION,
      mode: state.mode,
      dir: state.dir,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Non-fatal — quota / private mode / etc.
  }
}

export interface UseExplorerSort {
  sort: ExplorerSortSettings;
  setMode: (mode: ExplorerSortMode) => void;
  setDir: (dir: ExplorerSortDir) => void;
  toggleDir: () => void;
  resetSort: () => void;
}

/**
 * Module-level store so every `useExplorerSort()` caller shares ONE state.
 * The sort control and the data hook are rendered as siblings; with per-hook
 * `useState` they each held a private copy, so changing the control never
 * re-sorted the tree (it only updated the control's own checkmarks). A shared
 * store fixes that and keeps localStorage as the persistence layer.
 */
let sortStore: ExplorerSortSettings = readStoredSort();
const sortListeners = new Set<() => void>();

function setSortStore(next: ExplorerSortSettings): void {
  if (next.mode === sortStore.mode && next.dir === sortStore.dir) return;
  sortStore = next;
  writeStoredSort(next);
  for (const listener of sortListeners) listener();
}

function subscribeSort(listener: () => void): () => void {
  sortListeners.add(listener);
  return () => sortListeners.delete(listener);
}

function getSortSnapshot(): ExplorerSortSettings {
  return sortStore;
}

export function useExplorerSort(): UseExplorerSort {
  const sort = useSyncExternalStore(subscribeSort, getSortSnapshot, getSortSnapshot);

  // Re-sync from persistence on mount so a reload / other tab / a fresh mount
  // reflects the stored choice. Safe because every write also updates storage.
  useEffect(() => {
    setSortStore(readStoredSort());
  }, []);

  const setMode = useCallback((mode: ExplorerSortMode) => {
    setSortStore({ ...sortStore, mode });
  }, []);

  const setDir = useCallback((dir: ExplorerSortDir) => {
    setSortStore({ ...sortStore, dir });
  }, []);

  const toggleDir = useCallback(() => {
    setSortStore({ ...sortStore, dir: sortStore.dir === "asc" ? "desc" : "asc" });
  }, []);

  const resetSort = useCallback(() => {
    setSortStore(DEFAULT_EXPLORER_SORT);
  }, []);

  return { sort, setMode, setDir, toggleDir, resetSort };
}
