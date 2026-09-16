import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "nautilo.workbench.explorer.expanded.v1";
const SCHEMA_VERSION = 1;

interface StoredExpandedState {
  v: number;
  expanded: Record<string, boolean>;
}

function readStoredExpanded(): Record<string, boolean> {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return {};
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Partial<StoredExpandedState>;
    if (parsed.v !== SCHEMA_VERSION) return {};
    if (!parsed.expanded || typeof parsed.expanded !== "object") return {};

    const next: Record<string, boolean> = {};
    for (const [rowId, value] of Object.entries(parsed.expanded)) {
      if (value === true) next[rowId] = true;
    }
    return next;
  } catch {
    return {};
  }
}

function writeStoredExpanded(expanded: Record<string, boolean>): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const payload: StoredExpandedState = {
      v: SCHEMA_VERSION,
      expanded,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Non-fatal — quota / private mode / etc.
  }
}

export interface UseExplorerExpanded {
  /** Device-local expand map — true means expanded. Missing keys default collapsed. */
  expanded: Readonly<Record<string, boolean>>;
  isExpanded: (rowId: string) => boolean;
  setExpanded: (rowId: string, next: boolean) => void;
  toggleExpanded: (rowId: string) => void;
  resetExpanded: () => void;
}

export function useExplorerExpanded(): UseExplorerExpanded {
  const [expanded, setExpandedMap] = useState<Record<string, boolean>>(() =>
    readStoredExpanded(),
  );
  const didMount = useRef(false);

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    writeStoredExpanded(expanded);
  }, [expanded]);

  const isExpanded = useCallback(
    (rowId: string) => expanded[rowId] === true,
    [expanded],
  );

  const setExpanded = useCallback((rowId: string, next: boolean) => {
    setExpandedMap((prev) => {
      if (next) {
        if (prev[rowId] === true) return prev;
        return { ...prev, [rowId]: true };
      }
      if (!(rowId in prev)) return prev;
      const { [rowId]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const toggleExpanded = useCallback((rowId: string) => {
    setExpandedMap((prev) => {
      const next = !(prev[rowId] === true);
      if (next) {
        if (prev[rowId] === true) return prev;
        return { ...prev, [rowId]: true };
      }
      if (!(rowId in prev)) return prev;
      const { [rowId]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const resetExpanded = useCallback(() => {
    setExpandedMap({});
  }, []);

  return { expanded, isExpanded, setExpanded, toggleExpanded, resetExpanded };
}
