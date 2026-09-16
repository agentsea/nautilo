import { ShareWorkspaceDialog, type ShareWorkspaceFile } from "./share-workspace-dialog";
import { ContentAccessDialog } from "../content-access/content-access-dialog";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  AlertTriangle,
  Check,
  ChevronRight,
  ChevronDown,
  FileText,
  FolderPlus,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import { ApiError } from "@nautilo/api-client/browser";
import type { ArtifactDto } from "@nautilo/api-client/browser";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createWorkbenchPortal as createPortal } from "../workbench-portals";
import { useVirtualizer } from "@tanstack/react-virtual";
import { apiClient } from "../../lib/api";
import { matchingImportActionsForFile } from "../../apps/app-associations";
import {
  buildImportRequest,
  importActionLabel,
  openImportedResult,
  type ImportToolResult,
} from "../../apps/run-conversion";
import { useConversionRunner } from "../../apps/use-conversion-runner";
import { useInstalledApps } from "../../apps/use-installed-apps";
import { useRoomNavigation } from "../../contexts/room-navigation-context";
import { useToast } from "../toast";
import { SearchBar } from "./search-bar";
import { useConversationEncryptionPolicyMode, useToolActivity } from "../../adapters/runtime-contexts";
import { derivedCitedArtifactIds } from "./cited-paths";
import {
  artifactOpenFileTarget,
  shouldCloseManagedArtifactViewer,
  type ActiveArtifactTarget,
  type OpenFileTarget,
} from "./open-file-target";
import {
  buildNewEditablePath,
  inferEditableMimeType,
} from "../../editors/new-editable-path";
import {
  type ArtifactSortDir,
  type ArtifactSortMode,
} from "./artifact-sort";
import {
  buildTreeFromArtifacts,
  buildFolderMarkerPath,
  collectSiblingNamesAt,
  flattenTreeForRendering,
  isFolderMarkerPath,
  type ArtifactTreeNode,
} from "./artifact-tree";
import { ConfirmDialog } from "../confirm-dialog";
import { RenameArtifactDialog } from "../rename-artifact-dialog";
import { NewFileDialog } from "../new-file-dialog";
import { UndoRedoBar } from "../undo-redo-bar";
import { setArtifactRefOnDragData } from "../../lib/composer-paste-file";
import { isArtifactUploadAllowedByExtension } from "@nautilo/attachments/artifact-upload-policy";
import { useWorkspaceArtifacts } from "../../artifacts/workspace-artifacts-provider";
import { useCan } from "../../hooks/use-can";
import {
  artifactDropTargetPath,
  collectFolderDescendantArtifacts,
  countFolderChildren,
  detectRebaseCollisions,
  folderMarkerRowId,
  isArtifactTreeMoveDrag,
  isCyclicFolderDrop,
  isSameFolderNoOp,
  parseArtifactTreeMoveFromDataTransfer,
  planFolderRebase,
  planMoveToDir,
  resolveArtifactMoveRowId,
  setArtifactTreeMoveOnDragData,
  type ArtifactTreeMovePayload,
  type ArtifactTreeMoveSource,
  type FolderRebaseOp,
} from "./artifact-move";

const FILE_ROW_HEIGHT_PX = 24;
const VIRTUAL_OVERSCAN = 8;
const SEARCH_DEBOUNCE_MS = 120;
/** Matches the sort menu's `w-44` (11rem) so viewport clamping is exact. */
const SORT_MENU_WIDTH_PX = 176;

const LS_ARTIFACT_SORT_MODE = "nautilo.artifactSort.mode";
const LS_ARTIFACT_SORT_DIR = "nautilo.artifactSort.dir";
const LS_ARTIFACT_FOLDERS_FIRST = "nautilo.artifactSort.foldersFirst";

function buildArtifactRowClass(
  focused: boolean,
  selected = false,
  active = false,
): string {
  return [
    "flex min-w-0 flex-1 items-center gap-1 rounded py-0.5 text-left text-xs",
    selected || active
      ? "border-l-2 border-accent bg-[var(--tree-row-active)]"
      : "border-l-2 border-transparent",
    focused || active
      ? "bg-[var(--tree-row-active)] text-foreground"
      : "text-foreground-muted",
  ].join(" ");
}

function basenameLogicalPath(logicalPath: string): string {
  const norm = logicalPath.replace(/\\/g, "/");
  const seg = norm.split("/").pop();
  return seg && seg.length > 0 ? seg : logicalPath;
}

function EmptyWorkspaceArtifacts() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-xs text-foreground-muted">Your Genie hasn{"'"}t saved anything here yet.</p>
    </div>
  );
}

function NoSearchMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-xs text-foreground-muted">No files match &quot;{query}&quot;.</p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-md border border-border bg-background-element px-2 py-1 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
      >
        Clear search
      </button>
    </div>
  );
}

interface ArtifactRow {
  node: ArtifactTreeNode;
  depth: number;
}

export function ArtifactTreeView({
  onOpenFile,
  onOpenFileEdit,
  activeArtifact,
  onCloseActiveArtifact,
}: {
  onOpenFile?: (target: OpenFileTarget) => void;
  onOpenFileEdit?: (target: OpenFileTarget) => void;
  activeArtifact?: ActiveArtifactTarget | null;
  onCloseActiveArtifact?: () => void;
}) {
  const can = useCan();
  const canWriteArtifacts = can("write_artifacts");
  const canInvokeAgents = can("invoke_agents");
  const encryptionPolicyMode = useConversationEncryptionPolicyMode();
  const { activeRoomId } = useRoomNavigation();
  const activeArtifactId = activeArtifact?.id;
  const activeArtifactPath = activeArtifact?.path;
  const toast = useToast();
  const toolEvents = useToolActivity();
  const installedApps = useInstalledApps();
  const conversionRunner = useConversionRunner();
  const citedArtifactIds = useMemo(() => derivedCitedArtifactIds(toolEvents), [toolEvents]);
  const {
    artifacts,
    loading,
    error,
    refresh: refreshArtifacts,
    updateArtifacts: setArtifacts,
  } = useWorkspaceArtifacts();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  // Distinguishes "user actively focused/clicked a row" from the default
  // focusedIndex=0 on mount, so "New folder" with no interaction targets the
  // workspace root instead of silently nesting inside the first row (D357).
  const [hasFocusInteraction, setHasFocusInteraction] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<
    { rowId?: string; path: string; isDir?: boolean } | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<
    { rowId?: string; path: string; isDir?: boolean; childCount?: number } | null
  >(null);
  const [shareFiles, setShareFiles] = useState<{ files: ShareWorkspaceFile[]; roomId: string | null } | null>(null);
  const [manageAccessFiles, setManageAccessFiles] = useState<{ files: ShareWorkspaceFile[]; roomId: string } | null>(null);
  useEffect(() => { setShareFiles(null); setManageAccessFiles(null); }, [activeRoomId, encryptionPolicyMode]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);

  const [sortMode, setSortMode] = useState<ArtifactSortMode>(() => {
    try {
      const v = localStorage.getItem(LS_ARTIFACT_SORT_MODE);
      return v === "modified" || v === "size" ? v : "name";
    } catch {
      return "name";
    }
  });
  const [sortDir, setSortDir] = useState<ArtifactSortDir>(() => {
    try {
      return localStorage.getItem(LS_ARTIFACT_SORT_DIR) === "desc" ? "desc" : "asc";
    } catch {
      return "asc";
    }
  });
  const [foldersFirst, setFoldersFirst] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_ARTIFACT_FOLDERS_FIRST) !== "0";
    } catch {
      return true;
    }
  });
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const sortBtnRef = useRef<HTMLButtonElement | null>(null);
  const [sortMenuPos, setSortMenuPos] = useState<{ top: number; left: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);

  const fetchList = useCallback(() => {
    refreshArtifacts("artifact-tree");
  }, [refreshArtifacts]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const treeRoots = useMemo(
    () => buildTreeFromArtifacts(artifacts, { mode: sortMode, dir: sortDir, foldersFirst }),
    [artifacts, sortMode, sortDir, foldersFirst],
  );

  const recomputeSortMenuPos = useCallback(() => {
    const r = sortBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Left-anchored + viewport-clamped: the browser column is docked left, so a
    // right-anchored menu spills off the left edge. Open rightward (over the
    // chat surface — that's why this is a body portal).
    const maxLeft = Math.max(8, window.innerWidth - SORT_MENU_WIDTH_PX - 8);
    setSortMenuPos({
      top: Math.round(r.bottom + 4),
      left: Math.round(Math.min(Math.max(8, r.left), maxLeft)),
    });
  }, []);

  const toggleSortMenu = useCallback(() => {
    setSortMenuOpen((prev) => {
      if (!prev) recomputeSortMenuPos();
      return !prev;
    });
  }, [recomputeSortMenuPos]);

  const chooseSortMode = useCallback((mode: ArtifactSortMode) => {
    setSortMode(mode);
    try {
      localStorage.setItem(LS_ARTIFACT_SORT_MODE, mode);
    } catch {
      /* noop */
    }
  }, []);

  const chooseSortDir = useCallback((dir: ArtifactSortDir) => {
    setSortDir(dir);
    try {
      localStorage.setItem(LS_ARTIFACT_SORT_DIR, dir);
    } catch {
      /* noop */
    }
  }, []);

  const toggleFoldersFirst = useCallback(() => {
    setFoldersFirst((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_ARTIFACT_FOLDERS_FIRST, next ? "1" : "0");
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node;
      const inTrigger = sortBtnRef.current?.contains(target) ?? false;
      const inMenu = sortMenuRef.current?.contains(target) ?? false;
      if (!inTrigger && !inMenu) setSortMenuOpen(false);
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === "Escape") setSortMenuOpen(false);
    };
    const onReflow = () => recomputeSortMenuPos();
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
  }, [sortMenuOpen, recomputeSortMenuPos]);


  // Folders start collapsed. New folders created in-app expand their parent
  // explicitly; search temporarily reveals ancestor dirs of matches below.

  const toggleExpand = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const visibleRows = useMemo((): ArtifactRow[] => {
    const q = debouncedQuery.trim().toLowerCase();
    let allowed: Set<string> | null = null;
    // While searching, also expand ancestors of hits so nested matches are
    // visible even when folders are collapsed by default.
    let expandForRender: ReadonlySet<string> = expandedDirs;
    if (q) {
      allowed = new Set<string>();
      const searchExpanded = new Set(expandedDirs);
      const markAncestors = (leafPath: string) => {
        let p = leafPath;
        while (true) {
          allowed!.add(p);
          const i = p.lastIndexOf("/");
          if (i < 0) break;
          p = p.slice(0, i);
          searchExpanded.add(p);
        }
      };
      const walk = (nodes: ArtifactTreeNode[]) => {
        for (const n of nodes) {
          if (
            !n.isDir &&
            !isFolderMarkerPath(n.path) &&
            n.name.toLowerCase().includes(q)
          ) {
            markAncestors(n.path);
          }
          if (n.isDir && n.children) walk(n.children);
        }
      };
      walk(treeRoots);
      expandForRender = searchExpanded;
    }
    const flat = flattenTreeForRendering(treeRoots, expandForRender);
    if (!allowed) return flat;
    return flat.filter(({ node }) => allowed.has(node.path));
  }, [treeRoots, expandedDirs, debouncedQuery]);

  // Opening an artifact from chat/tool output bypasses the tree's click
  // handler. Reveal its logical parents here so the Workspace tree mirrors
  // the shell's active work surface instead of retaining a stale folder row.
  useEffect(() => {
    if (!activeArtifactPath) return;
    const ancestors: string[] = [];
    let path = activeArtifactPath.replace(/\\/g, "/");
    while (true) {
      const slash = path.lastIndexOf("/");
      if (slash < 0) break;
      path = path.slice(0, slash);
      if (path) ancestors.push(path);
    }
    if (ancestors.length === 0) return;
    setExpandedDirs((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const ancestor of ancestors) {
        if (next.has(ancestor)) continue;
        next.add(ancestor);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [activeArtifactId, activeArtifactPath]);

  const selectRange = useCallback(
    (fromKey: string, toKey: string) => {
      const fromIndex = visibleRows.findIndex((r) => r.node.key === fromKey);
      const toIndex = visibleRows.findIndex((r) => r.node.key === toKey);
      if (fromIndex < 0 || toIndex < 0) {
        setSelectedKeys(new Set([toKey]));
        setSelectionAnchor(toKey);
        return;
      }
      const [start, end] =
        fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
      const next = new Set<string>();
      for (let i = start; i <= end; i++) {
        const row = visibleRows[i];
        if (row?.node.rowId) next.add(row.node.key);
      }
      setSelectedKeys(next);
      setSelectionAnchor(fromKey);
    },
    [visibleRows],
  );

  const toggleSelected = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setSelectionAnchor(key);
  }, []);

  const selectedLeaves = useMemo(() => {
    const byKey = new Map<string, ArtifactTreeNode>();
    const walk = (nodes: ArtifactTreeNode[]) => {
      for (const n of nodes) {
        byKey.set(n.key, n);
        if (n.children) walk(n.children);
      }
    };
    walk(treeRoots);
    const leaves: ArtifactTreeNode[] = [];
    for (const key of selectedKeys) {
      const node = byKey.get(key);
      if (node?.rowId && !isFolderMarkerPath(node.path)) leaves.push(node);
    }
    return leaves;
  }, [selectedKeys, treeRoots]);

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setSelectionAnchor(null);
  }, []);

  const activeMenuNode = useMemo(() => {
    if (!menuKey) return null;
    return visibleRows.find((row) => row.node.key === menuKey)?.node ?? null;
  }, [menuKey, visibleRows]);

  const activeMenuImportMatches = useMemo(() => {
    if (installedApps.kind !== "ready") return [];
    if (!activeMenuNode || activeMenuNode.isDir || !activeMenuNode.rowId) return [];
    return matchingImportActionsForFile(
      installedApps.apps,
      artifactOpenFileTarget({
        id: activeMenuNode.rowId,
        path: activeMenuNode.path,
        mimeType: activeMenuNode.mimeType ?? "application/octet-stream",
        ...(activeRoomId ? { roomId: activeRoomId } : {}),
      }),
    );
  }, [activeMenuNode, activeRoomId, installedApps]);

  useLayoutEffect(() => {
    if (!menuKey) {
      setMenuStyle(null);
      return;
    }

    const updatePosition = (): void => {
      const anchor = menuAnchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const gap = 4;
      const margin = 8;
      const width = 144;
      const menuHeight = menuPanelRef.current?.offsetHeight ?? 112;
      const left = Math.min(
        Math.max(margin, rect.right - width),
        window.innerWidth - width - margin,
      );
      const below = rect.bottom + gap;
      const top =
        below + menuHeight <= window.innerHeight - margin
          ? below
          : Math.max(margin, rect.top - gap - menuHeight);

      setMenuStyle({
        position: "fixed",
        top,
        left,
        width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [menuKey]);

  useEffect(() => {
    if (!menuKey) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuKey(null);
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuAnchorRef.current?.contains(target)) return;
      if (menuPanelRef.current?.contains(target)) return;
      setMenuKey(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuKey]);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT_PX,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => visibleRows[index]?.node.key ?? index,
  });

  useEffect(() => {
    if (visibleRows.length === 0) return;
    setFocusedIndex((prev) => {
      if (prev < 0) return 0;
      if (prev >= visibleRows.length) return visibleRows.length - 1;
      return prev;
    });
  }, [visibleRows.length]);

  useEffect(() => {
    if (!activeArtifactId || !activeArtifactPath) return;
    const index = visibleRows.findIndex(
      ({ node }) => node.rowId === activeArtifactId,
    );
    if (index < 0) return;
    setFocusedIndex(index);
    // Programmatic reveal must not make "New folder" target this file's
    // parent; that behavior remains reserved for an explicit tree gesture.
    setHasFocusInteraction(false);
    virtualizer.scrollToIndex(index, { align: "auto" });
  }, [activeArtifactId, activeArtifactPath, visibleRows, virtualizer]);

  // Switching rooms is not an explicit row choice — reset so a fresh room's
  // "New folder" defaults to root until the user focuses/selects something.
  useEffect(() => {
    setHasFocusInteraction(false);
  }, [activeRoomId]);

  const focusRow = useCallback(
    (index: number) => {
      if (visibleRows.length === 0) return;
      const clamped = Math.max(0, Math.min(visibleRows.length - 1, index));
      setFocusedIndex(clamped);
      setHasFocusInteraction(true);
      virtualizer.scrollToIndex(clamped, { align: "auto" });
    },
    [visibleRows.length, virtualizer],
  );

  const handleApiErrorToast = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof ApiError) {
        if (e.status === 409) {
          toast.show({ variant: "warning", title: "Name in use", message: "A file already exists at that path." });
          return;
        }
        if (e.status === 404) {
          toast.show({
            variant: "warning",
            title: "Gone",
            message: "Artifact is no longer accessible. Refreshing the list.",
          });
          void fetchList();
          return;
        }
        if (e.status === 413) {
          toast.show({
            variant: "warning",
            title: "File too large",
            message: "File too big — reduce size or raise the server upload cap.",
          });
          return;
        }
        if (e.status === 403) {
          toast.show({
            variant: "warning",
            title: "Read-only",
            message: "This room is read-only for you; switch rooms to upload.",
          });
          return;
        }
      }
      toast.show({
        variant: "error",
        title: fallback,
        message: e instanceof Error ? e.message : String(e),
      });
    },
    [toast, fetchList],
  );

  const runRename = useCallback(
    async (rowId: string, newPath: string, prevArtifacts: ArtifactDto[]) => {
      try {
        const updated = await apiClient.renameWorkspaceArtifact(rowId, newPath, {
          roomId: activeRoomId ?? undefined,
        });
        setArtifacts((prev) => prev.map((a) => (a.id === rowId ? updated : a)));
      } catch (e) {
        setArtifacts(prevArtifacts);
        handleApiErrorToast(e, "Rename failed");
      }
    },
    [handleApiErrorToast, activeRoomId, setArtifacts],
  );

  const runDelete = useCallback(
    async (rowId: string, prevArtifacts: ArtifactDto[]) => {
      try {
        await apiClient.deleteWorkspaceArtifact(rowId, { roomId: activeRoomId ?? undefined });
      } catch (e) {
        setArtifacts(prevArtifacts);
        handleApiErrorToast(e, "Delete failed");
      }
    },
    [handleApiErrorToast, activeRoomId, setArtifacts],
  );

  const runFolderDelete = useCallback(
    async (folderPath: string) => {
      const toDelete = collectFolderDescendantArtifacts(artifacts, folderPath);
      if (toDelete.length === 0) return;
      const prev = artifacts;
      const ids = new Set(toDelete.map((a) => a.id));
      setArtifacts((cur) => cur.filter((a) => !ids.has(a.id)));
      let succeeded = 0;
      for (const item of toDelete) {
        try {
          await apiClient.deleteWorkspaceArtifact(item.id, { roomId: activeRoomId ?? undefined });
          succeeded++;
        } catch (e) {
          setArtifacts(prev);
          const remaining = toDelete.length - succeeded;
          if (remaining > 0 && succeeded > 0) {
            toast.show({
              variant: "error",
              title: "Delete failed",
              message: `${remaining} item${remaining === 1 ? "" : "s"} could not be deleted. Refreshing the list.`,
            });
          } else {
            handleApiErrorToast(e, "Delete failed");
          }
          void fetchList();
          return;
        }
      }
      void fetchList();
    },
    [activeRoomId, artifacts, fetchList, handleApiErrorToast, setArtifacts, toast],
  );

  // Single move engine for every artifact move path (single file, folder
  // rebase, multi-select). Runs a client-side collision pre-flight FIRST so a
  // colliding batch aborts atomically instead of half-applying and then
  // failing mid-loop on a server 409.
  const runRebaseOps = useCallback(
    async (ops: readonly FolderRebaseOp[]) => {
      if (ops.length === 0) return;
      const collisions = detectRebaseCollisions(artifacts, ops);
      if (collisions.length > 0) {
        toast.show({
          variant: "warning",
          title: "Name in use",
          message:
            collisions.length === 1
              ? `"${collisions[0]}" already exists at the destination.`
              : `${collisions.length} items already exist at the destination.`,
        });
        return;
      }
      const prev = artifacts;
      let succeeded = 0;
      try {
        for (const op of ops) {
          await apiClient.renameWorkspaceArtifact(op.rowId, op.newPath, {
            roomId: activeRoomId ?? undefined,
          });
          succeeded++;
        }
        void fetchList();
      } catch (e) {
        setArtifacts(prev);
        const remaining = ops.length - succeeded;
        if (remaining > 0 && succeeded > 0) {
          toast.show({
            variant: "error",
            title: "Move failed",
            message: `${remaining} item${remaining === 1 ? "" : "s"} could not be moved. Refreshing the list.`,
          });
        } else {
          handleApiErrorToast(e, "Move failed");
        }
        void fetchList();
      }
    },
    [activeRoomId, artifacts, fetchList, handleApiErrorToast, setArtifacts, toast],
  );

  const rebaseFolderArtifacts = useCallback(
    async (oldPrefix: string, newPrefix: string) => {
      if (oldPrefix === newPrefix) return;
      await runRebaseOps(planFolderRebase(artifacts, oldPrefix, newPrefix));
    },
    [artifacts, runRebaseOps],
  );

  const handleArtifactInternalDrop = useCallback(
    async (targetDirPath: string, payload: ArtifactTreeMovePayload) => {
      // Multi-select move: plan ops for every selected item at once and let
      // runRebaseOps' pre-flight decide atomically. Filter out no-ops and any
      // source that would be cyclic against this target.
      const multiSources =
        payload.items ??
        payload.paths?.map((path): ArtifactTreeMoveSource => ({ path, isDir: false }));
      if (multiSources && multiSources.length > 1) {
        const eligibleSources = multiSources.filter(
          (source) =>
            source.path !== targetDirPath &&
            (!source.isDir || !isCyclicFolderDrop(source.path, targetDirPath)),
        );
        if (eligibleSources.length === 0) return;
        let invalidReason: "missing" | "ambiguous" | null = null;
        const sources = eligibleSources.map((source) => {
          if (source.isDir) return source;
          const resolved = resolveArtifactMoveRowId(artifacts, source.path, source.rowId);
          if (!resolved.ok) {
            invalidReason = resolved.reason;
            return source;
          }
          return { ...source, rowId: resolved.rowId };
        });
        if (invalidReason) {
          toast.show({
            variant: "warning",
            title: "Move unavailable",
            message:
              invalidReason === "ambiguous"
                ? "More than one selected artifact has the same path. Select the intended rows and try again."
                : "A selected artifact is no longer available. Refreshing the list.",
          });
          if (invalidReason === "missing") void fetchList();
          return;
        }
        await runRebaseOps(planMoveToDir(artifacts, sources, targetDirPath));
        clearSelection();
        return;
      }

      if (isSameFolderNoOp(payload.path, targetDirPath)) return;
      if (payload.isDir && isCyclicFolderDrop(payload.path, targetDirPath)) return;

      if (payload.isDir) {
        const newPrefix = artifactDropTargetPath(payload.path, targetDirPath);
        if (newPrefix === payload.path) return;
        await rebaseFolderArtifacts(payload.path, newPrefix);
        return;
      }

      const newPath = artifactDropTargetPath(payload.path, targetDirPath);
      if (newPath === payload.path) return;
      const resolved = resolveArtifactMoveRowId(artifacts, payload.path, payload.rowId);
      if (!resolved.ok) {
        toast.show({
          variant: "warning",
          title: "Move unavailable",
          message:
            resolved.reason === "ambiguous"
              ? "More than one artifact has this path. Select the intended row and try again."
              : "Artifact is no longer available. Refreshing the list.",
        });
        if (resolved.reason === "missing") void fetchList();
        return;
      }
      await runRebaseOps([{ rowId: resolved.rowId, oldPath: payload.path, newPath }]);
    },
    [artifacts, clearSelection, fetchList, rebaseFolderArtifacts, runRebaseOps, toast],
  );

  const endInternalDrag = useCallback(() => {
    internalDragRef.current = null;
    setDragOverFolderPath(null);
    setRootMoveDragOver(false);
  }, []);

  const canDropOnFolder = useCallback((targetDirPath: string): boolean => {
    const payload = internalDragRef.current;
    if (!payload) return false;
    if (isSameFolderNoOp(payload.path, targetDirPath)) return false;
    if (payload.isDir && isCyclicFolderDrop(payload.path, targetDirPath)) return false;
    return true;
  }, []);

  const canDropOnRoot = useCallback((): boolean => {
    const payload = internalDragRef.current;
    if (!payload) return false;
    if (isSameFolderNoOp(payload.path, "")) return false;
    if (payload.isDir && isCyclicFolderDrop(payload.path, "")) return false;
    return true;
  }, []);

  const runBulkDelete = useCallback(async () => {
    const leaves = selectedLeaves;
    if (leaves.length === 0) return;
    const prev = artifacts;
    const ids = new Set(leaves.map((l) => l.rowId!));
    setBulkDeleteOpen(false);
    clearSelection();
    setArtifacts((cur) => cur.filter((a) => !ids.has(a.id)));
    for (const leaf of leaves) {
      try {
        await apiClient.deleteWorkspaceArtifact(leaf.rowId!, { roomId: activeRoomId ?? undefined });
      } catch (e) {
        setArtifacts(prev);
        handleApiErrorToast(e, "Delete failed");
        void fetchList();
        return;
      }
    }
    void fetchList();
  }, [
    activeRoomId,
    artifacts,
    clearSelection,
    fetchList,
    handleApiErrorToast,
    selectedLeaves,
    setArtifacts,
  ]);

  const runBulkDownload = useCallback(async () => {
    const ids = selectedLeaves
      .filter((l) => !isFolderMarkerPath(l.path))
      .map((l) => l.rowId)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    // D356 — single server-zipped download (one save dialog), not N per-file saves.
    try {
      await apiClient.downloadArtifactsZip(ids, { roomId: activeRoomId ?? undefined });
    } catch (e) {
      toast.show({
        variant: "warning",
        title: "Download failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [activeRoomId, selectedLeaves, toast]);

  const onLeafClick = useCallback(
    (node: ArtifactTreeNode) => {
      if (!onOpenFile || !node.rowId) return;
      onOpenFile(
        artifactOpenFileTarget({
          id: node.rowId,
          path: node.path,
          mimeType: node.mimeType ?? "application/octet-stream",
          ...(node.size !== undefined ? { sizeBytes: node.size } : {}),
          ...(activeRoomId ? { roomId: activeRoomId } : {}),
        }),
      );
    },
    [onOpenFile, activeRoomId],
  );

  const onTreeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const row = visibleRows[focusedIndex];
      if (!row && e.key !== "/") return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusRow(focusedIndex + 1);
          return;
        case "ArrowUp":
          e.preventDefault();
          focusRow(focusedIndex - 1);
          return;
        case "ArrowRight": {
          e.preventDefault();
          if (!row) return;
          if (row.node.isDir && !expandedDirs.has(row.node.path)) toggleExpand(row.node.path);
          else focusRow(focusedIndex + 1);
          return;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (!row) return;
          if (row.node.isDir && expandedDirs.has(row.node.path)) toggleExpand(row.node.path);
          return;
        }
        case "Enter": {
          e.preventDefault();
          if (!row) return;
          if (row.node.isDir) toggleExpand(row.node.path);
          else onLeafClick(row.node);
          return;
        }
        case "F2": {
          e.preventDefault();
          if (!canWriteArtifacts) return;
          if (row?.node.isDir) {
            setRenameTarget({ path: row.node.path, isDir: true });
          } else if (row?.node.rowId) {
            setRenameTarget({ rowId: row.node.rowId, path: row.node.path });
          }
          return;
        }
        case "Delete": {
          e.preventDefault();
          if (!canWriteArtifacts) return;
          if (row?.node.isDir) {
            setDeleteTarget({
              path: row.node.path,
              isDir: true,
              childCount: countFolderChildren(artifacts, row.node.path),
            });
          } else if (row?.node.rowId) {
            setDeleteTarget({ rowId: row.node.rowId, path: row.node.path });
          }
          return;
        }
        case "Backspace": {
          if (canWriteArtifacts && e.metaKey && row) {
            e.preventDefault();
            if (row.node.isDir) {
              setDeleteTarget({
                path: row.node.path,
                isDir: true,
                childCount: countFolderChildren(artifacts, row.node.path),
              });
            } else if (row.node.rowId) {
              setDeleteTarget({ rowId: row.node.rowId, path: row.node.path });
            }
          }
          return;
        }
        case "/": {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
          return;
        }
        case "Escape": {
          if (query.length > 0) {
            e.preventDefault();
            setQuery("");
          } else if (selectedKeys.size > 0) {
            e.preventDefault();
            clearSelection();
          }
          return;
        }
        case "Home":
          e.preventDefault();
          focusRow(0);
          return;
        case "End":
          e.preventDefault();
          focusRow(visibleRows.length - 1);
          return;
      }
    },
    [
      expandedDirs,
      focusRow,
      focusedIndex,
      onLeafClick,
      query.length,
      selectedKeys.size,
      clearSelection,
      toggleExpand,
      visibleRows,
      artifacts,
      canWriteArtifacts,
    ],
  );

  const handleSearchKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        if (query.length > 0) {
          e.preventDefault();
          setQuery("");
        } else {
          e.preventDefault();
          scrollRef.current?.focus();
        }
        return;
      }
      if (e.key === "ArrowDown" && visibleRows.length > 0) {
        e.preventDefault();
        setFocusedIndex(0);
        setHasFocusInteraction(true);
        scrollRef.current?.focus();
      }
    },
    [query, visibleRows.length],
  );

  const onDropFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      // D356 — client preflight against the broad artifact allowlist for instant
      // feedback; the server gate (POST /api/workspace/artifacts) is authoritative.
      const allowed: File[] = [];
      const skipped: string[] = [];
      for (const file of list) {
        if (isArtifactUploadAllowedByExtension(file.name)) allowed.push(file);
        else skipped.push(file.name);
      }
      if (skipped.length > 0) {
        toast.show({
          variant: "warning",
          title: `Skipped ${skipped.length} unsupported file${skipped.length === 1 ? "" : "s"}`,
          message: skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? "…" : ""),
        });
      }
      for (const file of allowed) {
        try {
          // M205: drops stay plain uploads; import runs from manifest-driven
          // context-menu or reader affordances once the file exists in Workspace.
          await apiClient.createWorkspaceArtifact(file, {
            path: file.name,
            mimeType: file.type || undefined,
            roomId: activeRoomId ?? undefined,
          });
        } catch (e) {
          handleApiErrorToast(e, "Upload failed");
        }
      }
      if (allowed.length > 0) void fetchList();
    },
    [fetchList, handleApiErrorToast, activeRoomId, toast],
  );

  const newFolderParentPath = useMemo((): string => {
    // Only honor the focused row as the target parent when the user actually
    // focused it — otherwise the default focusedIndex=0 would silently nest new
    // files/folders inside the first row. No explicit focus/selection → root.
    const focused = hasFocusInteraction ? visibleRows[focusedIndex]?.node : undefined;
    if (focused?.isDir) return focused.path;
    if (focused && !focused.isDir) {
      const slash = focused.path.lastIndexOf("/");
      return slash >= 0 ? focused.path.slice(0, slash) : "";
    }
    const byKey = new Map<string, ArtifactTreeNode>();
    const walk = (nodes: ArtifactTreeNode[]) => {
      for (const n of nodes) {
        byKey.set(n.key, n);
        if (n.children) walk(n.children);
      }
    };
    walk(treeRoots);
    for (const key of selectedKeys) {
      const selected = byKey.get(key);
      if (selected?.isDir) return selected.path;
    }
    return "";
  }, [focusedIndex, hasFocusInteraction, selectedKeys, treeRoots, visibleRows]);

  const validateNewArtifactName = useCallback(
    (name: string): string | null => {
      const built = buildNewEditablePath({
        parentPath: newFolderParentPath,
        name,
        existingNames: collectSiblingNamesAt(artifacts, newFolderParentPath),
      });
      return built.ok ? null : built.reason;
    },
    [artifacts, newFolderParentPath],
  );

  const validateNewFolderName = useCallback(
    (name: string): string | null => {
      const built = buildNewEditablePath({
        parentPath: newFolderParentPath,
        name,
        existingNames: collectSiblingNamesAt(artifacts, newFolderParentPath),
      });
      return built.ok ? null : built.reason;
    },
    [artifacts, newFolderParentPath],
  );

  const handleCreateFolder = useCallback(
    async (folderName: string) => {
      const built = buildNewEditablePath({
        parentPath: newFolderParentPath,
        name: folderName,
        existingNames: collectSiblingNamesAt(artifacts, newFolderParentPath),
      });
      if (!built.ok) {
        toast.show({
          variant: "warning",
          title: "Cannot create",
          message: built.reason,
        });
        return;
      }

      const markerPath = buildFolderMarkerPath(built.path);
      const mimeType = "text/markdown";
      const file = new Blob([""], { type: mimeType });

      try {
        await apiClient.createWorkspaceArtifact(file, {
          path: markerPath,
          mimeType,
          roomId: activeRoomId ?? undefined,
        });
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          if (newFolderParentPath.length > 0) next.add(newFolderParentPath);
          next.add(built.path);
          return next;
        });
        void fetchList();
        toast.show({
          variant: "success",
          title: "Folder created",
          message: built.path,
        });
        setNewFolderDialogOpen(false);
      } catch (e) {
        handleApiErrorToast(e, "Create folder failed");
      }
    },
    [
      activeRoomId,
      artifacts,
      fetchList,
      handleApiErrorToast,
      newFolderParentPath,
      toast,
    ],
  );

  const handleCreateNew = useCallback(async (name: string) => {
    if (!onOpenFileEdit) return;

    // Create inside the focused/selected directory (same context New folder
    // uses); fall back to the workspace root when nothing is focused.
    const built = buildNewEditablePath({
      parentPath: newFolderParentPath,
      name,
      existingNames: collectSiblingNamesAt(artifacts, newFolderParentPath),
    });
    if (!built.ok) {
      toast.show({
        variant: "warning",
        title: "Cannot create",
        message: built.reason,
      });
      return;
    }

    const mimeType = inferEditableMimeType(built.path);
    const file = new Blob([""], { type: mimeType });

    try {
      const created = await apiClient.createWorkspaceArtifact(file, {
        path: built.path,
        mimeType,
        roomId: activeRoomId ?? undefined,
      });
      setArtifacts((prev) => [...prev, created]);
      if (newFolderParentPath.length > 0) {
        setExpandedDirs((prev) => new Set(prev).add(newFolderParentPath));
      }
      void fetchList();
      onOpenFileEdit(
        artifactOpenFileTarget({
          id: created.id,
          path: created.path,
          mimeType: created.mimeType,
          ...(activeRoomId ? { roomId: activeRoomId } : {}),
        }),
      );
      setNewFileDialogOpen(false);
    } catch (e) {
      handleApiErrorToast(e, "Create failed");
    }
  }, [
    activeRoomId,
    artifacts,
    fetchList,
    handleApiErrorToast,
    newFolderParentPath,
    onOpenFileEdit,
    setArtifacts,
    toast,
  ]);

  const [dragOver, setDragOver] = useState(false);
  const [rootMoveDragOver, setRootMoveDragOver] = useState(false);
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null);
  const internalDragRef = useRef<ArtifactTreeMovePayload | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onUploadInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) void onDropFiles(files);
      // Reset so re-selecting the same file re-fires change.
      e.target.value = "";
    },
    [onDropFiles],
  );

  return (
    <div data-testid="artifact-tree-view" className="flex h-full min-h-0 flex-col">
      {canWriteArtifacts ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onUploadInputChange}
          data-testid="artifact-tree-upload-input"
        />
      ) : null}
      <div className="border-b border-border px-3 py-2">
        <SearchBar
          ref={searchInputRef}
          value={query}
          onChange={setQuery}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search"
        />
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        {canWriteArtifacts ? (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload files"
              title="Upload files"
              data-testid="artifact-tree-upload"
              className="shrink-0 rounded-md p-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
            >
              <Upload aria-hidden="true" size={14} />
            </button>
            <button
              type="button"
              onClick={() => setNewFileDialogOpen(true)}
              disabled={!onOpenFileEdit}
              aria-label="New file"
              title="New file"
              data-testid="artifact-tree-new-file"
              className="shrink-0 rounded-md border border-border bg-background-element px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus aria-hidden="true" size={12} className="mr-0.5 inline" />
              New
            </button>
            <button
              type="button"
              onClick={() => setNewFolderDialogOpen(true)}
              aria-label="New folder"
              title="New folder"
              data-testid="artifact-tree-new-folder"
              className="shrink-0 rounded-md border border-border bg-background-element px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)]"
            >
              <FolderPlus aria-hidden="true" size={12} className="mr-0.5 inline" />
              Folder
            </button>
          </>
        ) : null}
        <div className="shrink-0">
          <button
            ref={sortBtnRef}
            type="button"
            onClick={toggleSortMenu}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            aria-label="Sort artifacts"
            title="Sort artifacts"
            data-testid="artifact-tree-sort"
            className="rounded-md p-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
          >
            <ArrowDownUp aria-hidden="true" size={14} />
          </button>
          {sortMenuOpen && sortMenuPos
            ? createPortal(
                <div
                  ref={sortMenuRef}
                  role="menu"
                  aria-label="Sort artifacts"
                  style={{ position: "fixed", top: sortMenuPos.top, left: sortMenuPos.left }}
                  className="z-50 w-44 rounded-md border border-border bg-background-panel py-1 shadow-lg"
                >
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-dim">
                    Sort by
                  </div>
                  {(
                    [
                      ["name", "Name"],
                      ["modified", "Date modified"],
                      ["size", "Size"],
                    ] as ReadonlyArray<[ArtifactSortMode, string]>
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sortMode === mode}
                      onClick={() => chooseSortMode(mode)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--primary-muted)]"
                    >
                      <Check
                        aria-hidden="true"
                        size={12}
                        className={`shrink-0 ${sortMode === mode ? "text-accent" : "invisible"}`}
                      />
                      {label}
                    </button>
                  ))}

                  <div className="mx-2 my-1 border-t border-border/60" />

                  {(
                    [
                      ["asc", "Ascending", ArrowUp],
                      ["desc", "Descending", ArrowDown],
                    ] as ReadonlyArray<[ArtifactSortDir, string, typeof ArrowUp]>
                  ).map(([dir, label, Icon]) => (
                    <button
                      key={dir}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sortDir === dir}
                      onClick={() => chooseSortDir(dir)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--primary-muted)]"
                    >
                      <Check
                        aria-hidden="true"
                        size={12}
                        className={`shrink-0 ${sortDir === dir ? "text-accent" : "invisible"}`}
                      />
                      <Icon aria-hidden="true" size={12} className="shrink-0 text-foreground-muted" />
                      {label}
                    </button>
                  ))}

                  <div className="mx-2 my-1 border-t border-border/60" />

                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={foldersFirst}
                    onClick={toggleFoldersFirst}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--primary-muted)]"
                  >
                    <Check
                      aria-hidden="true"
                      size={12}
                      className={`shrink-0 ${foldersFirst ? "text-accent" : "invisible"}`}
                    />
                    Folders first
                  </button>
                </div>,
                document.body,
              )
            : null}
        </div>
        <button
          type="button"
          onClick={() => {
            void fetchList();
          }}
          aria-label="Refresh artifacts"
          title="Refresh artifacts"
          className="shrink-0 rounded-md p-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <RefreshCw aria-hidden="true" size={14} />
        </button>
      </div>
      <UndoRedoBar />

      {selectedLeaves.length > 0 ? (
        <div
          data-testid="artifact-tree-selection-bar"
          className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5"
        >
          <span className="text-[11px] text-foreground-muted">
            {selectedLeaves.length} selected
          </span>
          <button
            type="button"
            data-testid="artifact-tree-bulk-download"
            onClick={() => void runBulkDownload()}
            className="rounded-md border border-border bg-background-element px-2 py-0.5 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
          >
            Download
          </button>
          <button
            type="button"
            data-testid="artifact-tree-bulk-delete"
            onClick={() => setBulkDeleteOpen(true)}
            className="rounded-md border border-border bg-background-element px-2 py-0.5 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
          >
            Delete
          </button>
          {canWriteArtifacts && <button
            type="button"
            data-testid="artifact-tree-bulk-share"
            onClick={() => {
              const files = selectedLeaves.flatMap((node) => node.rowId ? [{ id: node.rowId, path: node.path }] : []);
              if (encryptionPolicyMode === "plaintext_only") {
                if (activeRoomId) setManageAccessFiles({ roomId: activeRoomId, files });
                return;
              }
              setShareFiles({ roomId: activeRoomId, files });
            }}
            className="rounded-md border border-border bg-background-element px-2 py-0.5 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
          >{encryptionPolicyMode === "plaintext_only" ? "Manage access…" : "Add to workspace…"}</button>}
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto text-[11px] text-foreground-muted hover:text-foreground"
          >
            Clear
          </button>
        </div>
      ) : null}

      <div
        className={[
          "relative min-h-0 flex-1",
          dragOver || rootMoveDragOver ? "ring-2 ring-inset ring-accent/60" : "",
        ].join(" ")}
        onDragEnter={(e) => {
          if (!canWriteArtifacts) return;
          e.preventDefault();
          if (isArtifactTreeMoveDrag(e.dataTransfer)) {
            if (canDropOnRoot()) setRootMoveDragOver(true);
            return;
          }
          if (Array.from(e.dataTransfer.types ?? []).includes("Files")) {
            setDragOver(true);
          }
        }}
        onDragOver={(e) => {
          if (!canWriteArtifacts) return;
          e.preventDefault();
          if (isArtifactTreeMoveDrag(e.dataTransfer)) {
            e.dataTransfer.dropEffect = canDropOnRoot() ? "move" : "none";
            if (canDropOnRoot()) setRootMoveDragOver(true);
            return;
          }
          if (Array.from(e.dataTransfer.types ?? []).includes("Files")) {
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragOver(false);
          setRootMoveDragOver(false);
          setDragOverFolderPath(null);
        }}
        onDrop={(e) => {
          if (!canWriteArtifacts) return;
          e.preventDefault();
          setDragOver(false);
          setRootMoveDragOver(false);
          setDragOverFolderPath(null);
          if (isArtifactTreeMoveDrag(e.dataTransfer)) {
            const payload =
              parseArtifactTreeMoveFromDataTransfer(e.dataTransfer) ??
              internalDragRef.current;
            if (payload) void handleArtifactInternalDrop("", payload);
            endInternalDrag();
            return;
          }
          if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            void onDropFiles(e.dataTransfer.files);
          }
        }}
      >
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertTriangle className="h-5 w-5 text-[var(--warning)]" aria-hidden="true" />
            <p className="max-w-[16rem] text-xs text-foreground">{error}</p>
            <button
              type="button"
              onClick={() => {
                void fetchList();
              }}
              className="rounded-md border border-border bg-background-element px-2 py-1 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div data-testid="artifact-tree-loading" className="flex h-full items-center justify-center">
            <span className="text-xs text-foreground-muted">Loading workspace…</span>
          </div>
        ) : artifacts.length === 0 ? (
          <EmptyWorkspaceArtifacts />
        ) : visibleRows.length === 0 ? (
          <NoSearchMatches query={debouncedQuery} onClear={() => setQuery("")} />
        ) : (
          <div
            ref={scrollRef}
            role="tree"
            aria-multiselectable="true"
            aria-label="Genie workspace artifacts"
            tabIndex={0}
            className="h-full min-h-0 overflow-y-auto outline-none"
            onKeyDown={onTreeKeyDown}
          >
            <div
              className="relative w-full text-xs"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const row = visibleRows[vi.index];
                if (!row) return null;
                const { node, depth } = row;
                const focused = vi.index === focusedIndex;
                const selected = selectedKeys.has(node.key);
                const active =
                  Boolean(activeArtifact) &&
                  node.rowId === activeArtifact?.id;
                const cited = Boolean(node.artifactId && citedArtifactIds.has(node.artifactId));
                const indent = { paddingLeft: `${8 + depth * 14}px` };

                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    data-path={node.path}
                    data-node-key={node.key}
                    data-testid={node.rowId ? "artifact-tree-leaf" : "artifact-tree-dir"}
                    className={[
                      "absolute left-0 right-0 top-0 flex w-full min-w-0 items-center gap-1 border-b border-transparent pr-1 hover:bg-background-element",
                      // Virtualized rows are painted in DOM order; the ⋯ menu extends below the row,
                      // so the next row would otherwise paint on top of the menu (looks like a "transparent" menu).
                      menuKey === node.key ? "z-30" : "",
                    ].join(" ")}
                    style={{
                      transform: `translateY(${vi.start}px)`,
                      height: `${vi.size}px`,
                    }}
                  >
                    <button
                      type="button"
                      role="treeitem"
                      aria-expanded={node.isDir ? expandedDirs.has(node.path) : undefined}
                      aria-selected={selectedKeys.size > 0 ? selected : focused}
                      aria-current={active ? "page" : undefined}
                      tabIndex={-1}
                      style={indent}
                      className={[
                        buildArtifactRowClass(focused, selected, active),
                        node.isDir && dragOverFolderPath === node.path
                          ? "ring-1 ring-inset ring-accent bg-[var(--primary-muted)]"
                          : "",
                      ].join(" ")}
                      onClick={(e) => {
                        setFocusedIndex(vi.index);
                        setHasFocusInteraction(true);
                        if (node.isDir) {
                          toggleExpand(node.path);
                          return;
                        }
                        if (e.metaKey || e.ctrlKey) {
                          toggleSelected(node.key);
                          return;
                        }
                        if (e.shiftKey) {
                          selectRange(selectionAnchor ?? node.key, node.key);
                          return;
                        }
                        setSelectedKeys(new Set());
                        setSelectionAnchor(node.key);
                        onLeafClick(node);
                      }}
                      draggable={canWriteArtifacts ? node.isDir || Boolean(node.rowId) : Boolean(node.rowId)}
                      onDragStart={(ev: DragEvent<HTMLButtonElement>) => {
                        if (!canWriteArtifacts) {
                          if (node.artifactId) {
                            setArtifactRefOnDragData(ev, {
                              kind: "artifact",
                              artifactId: node.artifactId,
                              path: node.path,
                              mimeType: node.mimeType ?? "application/octet-stream",
                              size: node.size ?? 0,
                            });
                            ev.dataTransfer.effectAllowed = "copy";
                          }
                          return;
                        }
                        if (node.isDir) {
                          const payload: ArtifactTreeMovePayload = {
                            kind: "artifact",
                            path: node.path,
                            rowId: folderMarkerRowId(artifacts, node.path),
                            isDir: true,
                          };
                          setArtifactTreeMoveOnDragData(ev.dataTransfer, payload);
                          internalDragRef.current = payload;
                          ev.dataTransfer.effectAllowed = "move";
                          return;
                        }
                        const isMultiDrag =
                          selectedKeys.has(node.key) && selectedKeys.size > 1;
                        const movePayload: ArtifactTreeMovePayload = {
                          kind: "artifact",
                          path: node.path,
                          rowId: node.rowId,
                          isDir: false,
                          ...(isMultiDrag
                            ? {
                                items: selectedLeaves.map((selectedNode) => ({
                                  path: selectedNode.path,
                                  rowId: selectedNode.rowId,
                                  isDir: false,
                                })),
                              }
                            : {}),
                        };
                        setArtifactTreeMoveOnDragData(ev.dataTransfer, movePayload);
                        internalDragRef.current = movePayload;
                        if (node.artifactId) {
                          setArtifactRefOnDragData(ev, {
                            kind: "artifact",
                            artifactId: node.artifactId,
                            path: node.path,
                            mimeType: node.mimeType ?? "application/octet-stream",
                            size: node.size ?? 0,
                          });
                        }
                        // Set LAST: setArtifactRefOnDragData resets effectAllowed
                        // to "copy", which makes a folder reject the "move" drop
                        // (files bounce back). copyMove permits move + composer copy.
                        ev.dataTransfer.effectAllowed = "copyMove";
                      }}
                      onDragEnd={endInternalDrag}
                      onDragOver={
                        canWriteArtifacts && node.isDir
                          ? (ev) => {
                              if (!isArtifactTreeMoveDrag(ev.dataTransfer)) return;
                              ev.preventDefault();
                              ev.stopPropagation();
                              ev.dataTransfer.dropEffect = canDropOnFolder(node.path)
                                ? "move"
                                : "none";
                              if (canDropOnFolder(node.path)) {
                                setDragOverFolderPath(node.path);
                              }
                            }
                          : undefined
                      }
                      onDragLeave={
                        canWriteArtifacts && node.isDir
                          ? () => {
                              if (dragOverFolderPath === node.path) {
                                setDragOverFolderPath(null);
                              }
                            }
                          : undefined
                      }
                      onDrop={
                        canWriteArtifacts && node.isDir
                          ? (ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              setDragOverFolderPath(null);
                              setRootMoveDragOver(false);
                              const payload =
                                parseArtifactTreeMoveFromDataTransfer(ev.dataTransfer) ??
                                internalDragRef.current;
                              if (!payload) return;
                              void handleArtifactInternalDrop(node.path, payload);
                              endInternalDrag();
                            }
                          : undefined
                      }
                    >
                      {node.isDir ? (
                        expandedDirs.has(node.path) ? (
                          <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                        )
                      ) : (
                        <FileText className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                      )}
                      <span className="truncate">{node.label}</span>
                      {cited && (
                        <span
                          aria-label="cited in conversation"
                          title="Cited in conversation"
                          className="ml-1 flex-shrink-0 text-[10px]"
                          style={{ color: "var(--accent)" }}
                        >
                          ●
                        </span>
                      )}
                    </button>
                    {(node.rowId || node.isDir) ? (
                      <div className="relative shrink-0">
                        <button
                          ref={menuKey === node.key ? menuAnchorRef : undefined}
                          type="button"
                          className="rounded px-1 text-xs text-foreground-muted hover:text-foreground"
                          aria-label="Row actions"
                          aria-expanded={menuKey === node.key}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusedIndex(vi.index);
                            setHasFocusInteraction(true);
                            if (menuKey === node.key) {
                              menuAnchorRef.current = null;
                              setMenuKey(null);
                              return;
                            }
                            menuAnchorRef.current = e.currentTarget;
                            setMenuKey(node.key);
                          }}
                        >
                          ⋯
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {shareFiles && shareFiles.roomId === activeRoomId && <ShareWorkspaceDialog
        files={shareFiles.files} roomId={shareFiles.roomId ?? undefined} onClose={() => setShareFiles(null)}
      />}
      {manageAccessFiles && manageAccessFiles.roomId === activeRoomId && <ContentAccessDialog
        subjects={manageAccessFiles.files.map((file) => ({ object: { kind: "artifact", id: file.id }, label: file.path }))}
        roomId={manageAccessFiles.roomId}
        onChanged={() => { void refreshArtifacts(); }}
        onAccessLost={(message) => {
          if (shouldCloseManagedArtifactViewer(activeArtifact, manageAccessFiles.files)) onCloseActiveArtifact?.();
          toast.show({ variant: "info", title: "Access updated", message });
        }}
        onClose={() => setManageAccessFiles(null)}
      />}
      {activeMenuNode && typeof document !== "undefined" ? (
        createPortal(
          <div
            ref={menuPanelRef}
            role="menu"
            aria-label={`Actions for ${activeMenuNode.name}`}
            className="z-50 rounded border border-border bg-background-panel py-1 text-xs shadow-md"
            style={menuStyle ?? undefined}
          >
            {!activeMenuNode.isDir && activeMenuNode.rowId ? (
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-1.5 text-left hover:bg-background-element"
                onClick={() => {
                  const node = activeMenuNode;
                  setMenuKey(null);
                  void (async () => {
                    try {
                      await apiClient.downloadArtifact(node.rowId!, basenameLogicalPath(node.path), {
                        roomId: activeRoomId ?? undefined,
                      });
                    } catch (e) {
                      toast.show({
                        variant: "warning",
                        title: "Save failed",
                        message: e instanceof Error ? e.message : String(e),
                      });
                    }
                  })();
                }}
              >
                Save to disk…
              </button>
            ) : null}
            {canWriteArtifacts && !activeMenuNode.isDir && activeMenuNode.rowId && <button
              type="button" role="menuitem"
              className="block w-full px-3 py-1.5 text-left hover:bg-background-element"
              onClick={() => {
                const files = [{ id: activeMenuNode.rowId!, path: activeMenuNode.path }];
                if (encryptionPolicyMode === "plaintext_only") {
                  if (activeRoomId) setManageAccessFiles({ roomId: activeRoomId, files });
                } else setShareFiles({ roomId: activeRoomId, files });
                setMenuKey(null);
              }}
            >{encryptionPolicyMode === "plaintext_only" ? "Manage access…" : "Add to someone’s workspace…"}</button>}
            {canInvokeAgents && canWriteArtifacts ? activeMenuImportMatches.map((match) => (
              <button
                key={`${match.app.id}:${match.action.id}`}
                type="button"
                role="menuitem"
                className="block w-full px-3 py-1.5 text-left hover:bg-background-element"
                onClick={() => {
                  const node = activeMenuNode;
                  setMenuKey(null);
                  if (!node.rowId) return;
                  void (async () => {
                    const file = artifactOpenFileTarget({
                      id: node.rowId!,
                      path: node.path,
                      mimeType: node.mimeType ?? "application/octet-stream",
                      ...(activeRoomId ? { roomId: activeRoomId } : {}),
                    });
                    const outcome = await conversionRunner.run(
                      match.app.id,
                      buildImportRequest(match.action, file),
                    );
                    if (outcome.status === "cancelled") return;
                    if (outcome.status === "error") {
                      toast.show({ variant: "error", title: "Import failed", message: outcome.message });
                      return;
                    }
                    const result = outcome.result as ImportToolResult;
                    if (result.status !== "imported") {
                      toast.show({
                        variant: "error",
                        title: "Import failed",
                        message: result.message ?? result.error ?? "Import failed",
                      });
                      return;
                    }
                    const opened = await openImportedResult(
                      match.app,
                      match.action,
                      file,
                      result,
                      activeRoomId ?? undefined,
                    );
                    void fetchList();
                    if (!opened.opened) {
                      toast.show({
                        variant: "success",
                        title: "Imported",
                        message: opened.artifactPath ?? "Import completed.",
                      });
                    }
                  })();
                }}
              >
                {importActionLabel(match.app)}
              </button>
            )) : null}
            {canWriteArtifacts ? <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left hover:bg-background-element"
              onClick={() => {
                const node = activeMenuNode;
                setMenuKey(null);
                if (node.isDir) {
                  setRenameTarget({ path: node.path, isDir: true });
                } else {
                  setRenameTarget({ rowId: node.rowId!, path: node.path });
                }
              }}
            >
              Rename…
            </button> : null}
            {canWriteArtifacts ? <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left hover:bg-background-element"
              onClick={() => {
                const node = activeMenuNode;
                setMenuKey(null);
                if (node.isDir) {
                  setDeleteTarget({
                    path: node.path,
                    isDir: true,
                    childCount: countFolderChildren(artifacts, node.path),
                  });
                } else {
                  setDeleteTarget({ rowId: node.rowId!, path: node.path });
                }
              }}
            >
              {activeMenuNode.isDir ? "Delete folder" : "Delete"}
            </button> : null}
          </div>,
          document.body,
        )
      ) : null}

      {renameTarget ? (
        <RenameArtifactDialog
          initialPath={renameTarget.path}
          onCancel={() => setRenameTarget(null)}
          onSave={(newPath) => {
            if (renameTarget.isDir) {
              setRenameTarget(null);
              void rebaseFolderArtifacts(renameTarget.path, newPath);
              return;
            }
            const prev = artifacts;
            const rowId = renameTarget.rowId!;
            setRenameTarget(null);
            setArtifacts((cur) =>
              cur.map((a) => (a.id === rowId ? { ...a, path: newPath } : a)),
            );
            void runRename(rowId, newPath, prev);
          }}
        />
      ) : null}

      {newFolderDialogOpen ? (
        <NewFileDialog
          title="New workspace folder"
          description="Create an empty folder in the current Workspace location."
          initialName="New folder"
          validateName={validateNewFolderName}
          onCancel={() => setNewFolderDialogOpen(false)}
          onCreate={(name) => void handleCreateFolder(name)}
        />
      ) : null}

      {newFileDialogOpen ? (
        <NewFileDialog
          title="New workspace file"
          description="Create a blank editable artifact in the current Workspace."
          validateName={validateNewArtifactName}
          onCancel={() => setNewFileDialogOpen(false)}
          onCreate={(name) => void handleCreateNew(name)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={deleteTarget.isDir ? "Delete folder?" : "Delete artifact?"}
          body={
            deleteTarget.isDir
              ? `Delete folder ${deleteTarget.path} and ${deleteTarget.childCount ?? 0} item${(deleteTarget.childCount ?? 0) === 1 ? "" : "s"}? This hides them from your Workspace; the agent can still see history.`
              : `Delete ${deleteTarget.path}? This hides it from your Workspace; the agent can still see history.`
          }
          confirmLabel="Delete"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            if (deleteTarget.isDir) {
              const folderPath = deleteTarget.path;
              setDeleteTarget(null);
              void runFolderDelete(folderPath);
              return;
            }
            const prev = artifacts;
            const id = deleteTarget.rowId!;
            setDeleteTarget(null);
            setArtifacts((cur) => cur.filter((a) => a.id !== id));
            void runDelete(id, prev);
          }}
        />
      ) : null}

      {bulkDeleteOpen ? (
        <ConfirmDialog
          title="Delete artifacts?"
          body={`Delete ${selectedLeaves.length} artifact${selectedLeaves.length === 1 ? "" : "s"}? This hides them from your Workspace; the agent can still see history.`}
          confirmLabel="Delete"
          onCancel={() => setBulkDeleteOpen(false)}
          onConfirm={() => void runBulkDelete()}
        />
      ) : null}

      {conversionRunner.conflictDialog}
    </div>
  );
}
