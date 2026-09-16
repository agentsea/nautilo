/**
 * Shared virtualized file tree (D075) used by the **Files** tab (root =
 * current folder) and the **Workspace** tab (D079, root = Genie workspace).
 *
 * Same lazy tree, ignore rules, .gitignore-at-root, search debounce,
 * keyboard nav, and cited-file glyph — only the mount root + a few
 * labels differ.
 *
 * The **Files** tab can queue a clicked file into the composer (legacy prop:
 * `pasteFileIntoComposer`); the **Workspace** tab turns that off so browsing
 * does not alter the draft. Users can also **drag** a file onto the composer
 * to attach it as a chip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWorkbenchPortal as createPortal } from "../workbench-portals";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ChevronDown, AlertTriangle, FileText, Eye, EyeOff, RefreshCw, ArrowDownUp, ArrowDown, ArrowUp, Check, Plus, FolderPlus, Trash2 } from "lucide-react";
import type { FsMkdirResult, FsRenameResult, FsTrashResult } from "../../lib/desktop";
import { basename } from "../../lib/file-preview";
import { ConfirmDialog } from "../confirm-dialog";
import ignore, { type Ignore } from "ignore";
import { desktopAPI } from "../../lib/desktop";
import { queueFileAttachmentFromPath, setNautiloFileRefOnDragData } from "../../lib/composer-paste-file";
import { formatComposerAttachmentSkipToast } from "../../lib/composer-attachment-preflight";
import { useToast } from "../../components/toast";
import { SearchBar } from "./search-bar";
import { useToolActivity } from "../../adapters/runtime-contexts";
import { useWorkspaceArtifactEventHub } from "../../artifacts/workspace-artifacts-provider";
import { localFileCommittedMutationPath } from "../../artifacts/workspace-document-mutation-events";
import { derivedCitedPaths, isUnderRoot, joinPath, relativeFromWorkspace, separatorFor } from "./cited-paths";
import { fsOpenFileTarget, type OpenFileTarget } from "./open-file-target";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IGNORE_NAMES = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  ".DS_Store",
]);

const IGNORE_PATTERNS: readonly RegExp[] = [
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}(?:_(?:IN|OUT))?$/i,
  /^com\.apple\.launchd\./,
  /^sock-\d+$/,
  /^powerlog$/i,
];

/** Shared by Files and Workspace tabs so the toggle feels global. */
const LS_SHOW_HIDDEN = "nautilo.files.showHidden";
/** Matches the sort menu's `w-44` (11rem) so viewport clamping is exact. */
const SORT_MENU_WIDTH_PX = 176;
const LS_SORT_MODE = "nautilo.files.sortMode";
const LS_SORT_DIR = "nautilo.files.sortDir";
const LS_FOLDERS_FIRST = "nautilo.files.foldersFirst";

const FILE_ROW_HEIGHT_PX = 24;
const VIRTUAL_OVERSCAN = 8;
const SEARCH_DEBOUNCE_MS = 120;
const LIVE_REFRESH_DEBOUNCE_MS = 350;

/** Internal move payload MIME — local to the Files tree (not composer file-ref). */
const FILE_TREE_MOVE_MIME = "application/x-nautilo-file-tree-move";

export type FileTreeMovePayload = {
  kind: "file-tree";
  path: string;
  type: "file" | "directory";
};

export type FileTreeCreateFolderContext = {
  parentPath: string;
  siblingNames: readonly string[];
};

function setFileTreeMoveOnDragData(
  e: DragEvent,
  payload: FileTreeMovePayload,
): void {
  e.dataTransfer.setData(FILE_TREE_MOVE_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "move";
}

function readFileTreeMovePayload(
  dataTransfer: DataTransfer,
): FileTreeMovePayload | null {
  const raw = dataTransfer.getData(FILE_TREE_MOVE_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as FileTreeMovePayload).kind === "file-tree" &&
      typeof (parsed as FileTreeMovePayload).path === "string" &&
      ((parsed as FileTreeMovePayload).type === "file" ||
        (parsed as FileTreeMovePayload).type === "directory")
    ) {
      return parsed as FileTreeMovePayload;
    }
  } catch {
    /* invalid payload */
  }
  return null;
}

function hasFileTreeMovePayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(FILE_TREE_MOVE_MIME);
}

export function buildMoveDestinationPath(fromPath: string, toDirPath: string): string {
  return joinPath(toDirPath, basename(fromPath));
}

export function parentDirectoryPath(filePath: string, rootPath: string): string {
  if (filePath === rootPath) return rootPath;
  const sep = separatorFor(rootPath);
  const idx = filePath.lastIndexOf(sep);
  if (idx <= 0) return rootPath;
  const parent = filePath.slice(0, idx);
  return parent.length >= rootPath.length ? parent : rootPath;
}

export function localCommittedMutationRefreshPath(
  event: Parameters<typeof localFileCommittedMutationPath>[0],
  rootPath: string,
): string | null {
  const changedPath = localFileCommittedMutationPath(event);
  if (!changedPath || !isUnderRoot(rootPath, changedPath)) return null;
  return parentDirectoryPath(changedPath, rootPath);
}

export function isCyclicFolderMove(sourceDirPath: string, targetDirPath: string): boolean {
  if (sourceDirPath === targetDirPath) return true;
  return isUnderRoot(sourceDirPath, targetDirPath);
}

export function resolveCreateFolderParent(args: {
  focusedRow: { entry: { path: string; type: "file" | "directory" } } | undefined;
  rootPath: string;
  selectedPaths: ReadonlySet<string>;
  entries: ReadonlyMap<string, { path: string; type: "file" | "directory" }>;
}): string {
  const focused = args.focusedRow?.entry;
  if (focused?.type === "directory") return focused.path;
  if (focused?.type === "file") return parentDirectoryPath(focused.path, args.rootPath);
  for (const path of args.selectedPaths) {
    const entry = args.entries.get(path);
    if (entry?.type === "directory") return entry.path;
  }
  return args.rootPath;
}

export function collectSiblingNamesAt(
  entries: ReadonlyMap<string, { name: string; childrenPaths?: string[] | null }>,
  parentPath: string,
  rootPath: string,
  rootPaths: readonly string[] | null,
): string[] {
  const resolvedChildPaths =
    parentPath === rootPath
      ? (rootPaths ?? [])
      : (entries.get(parentPath)?.childrenPaths ?? []);
  return resolvedChildPaths
    .map((p) => entries.get(p)?.name)
    .filter((name): name is string => Boolean(name));
}

export function formatFsMoveError(
  code: "exists" | "forbidden" | "error",
  message?: string,
): { title: string; message: string } {
  switch (code) {
    case "exists":
      return {
        title: "Name in use",
        message: message ?? "A file or folder with that name already exists at the destination.",
      };
    case "forbidden":
      return {
        title: "Move blocked",
        message: message ?? "That path is not allowed.",
      };
    default:
      return {
        title: "Move failed",
        message: message ?? "Could not move the item.",
      };
  }
}

export function formatFsMkdirError(
  code: "exists" | "forbidden" | "error",
  message?: string,
): { title: string; message: string } {
  switch (code) {
    case "exists":
      return {
        title: "Name in use",
        message: message ?? "A file or folder with that name already exists.",
      };
    case "forbidden":
      return {
        title: "Create blocked",
        message: message ?? "That path is not allowed.",
      };
    default:
      return {
        title: "Create failed",
        message: message ?? "Could not create the folder.",
      };
  }
}

export async function executeFileTreeMove(args: {
  rename: (from: string, to: string) => Promise<FsRenameResult>;
  fromPath: string;
  fromType: "file" | "directory";
  toDirPath: string;
}): Promise<
  | { ok: true; destPath: string }
  | { ok: false; reason: "noop" | "cyclic" | "exists" | "forbidden" | "error"; message?: string }
> {
  const destPath = buildMoveDestinationPath(args.fromPath, args.toDirPath);
  if (args.fromPath === destPath) return { ok: false, reason: "noop" };
  if (args.fromType === "directory" && isCyclicFolderMove(args.fromPath, args.toDirPath)) {
    return { ok: false, reason: "cyclic", message: "Cannot move a folder into itself or its subfolder." };
  }
  const result = await args.rename(args.fromPath, destPath);
  if (!result.ok) {
    return { ok: false, reason: result.code, message: result.message };
  }
  return { ok: true, destPath };
}

export async function executeFileTreeMkdir(args: {
  mkdir: (path: string) => Promise<FsMkdirResult>;
  path: string;
}): Promise<
  | { ok: true }
  | { ok: false; code: "exists" | "forbidden" | "error"; message?: string }
> {
  const result = await args.mkdir(args.path);
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { ok: true };
}

export async function executeFileTreeTrash(args: {
  trash: (path: string) => Promise<FsTrashResult>;
  path: string;
}): Promise<
  | { ok: true }
  | { ok: false; code: "forbidden" | "error"; message?: string }
> {
  const result = await args.trash(args.path);
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { ok: true };
}

export function formatFsTrashError(
  code: "forbidden" | "error",
  message?: string,
): { title: string; message: string } {
  switch (code) {
    case "forbidden":
      return {
        title: "Delete blocked",
        message: message ?? "That path is not allowed.",
      };
    default:
      return {
        title: "Delete failed",
        message: message ?? "Could not move the item to Trash.",
      };
  }
}

// ---------------------------------------------------------------------------
// Row styling
// ---------------------------------------------------------------------------

/**
 * Class string for a single file-tree row button.
 *
 * Extracted from inline JSX so the outline-suppression invariants are
 * unit-testable. The yellow `:focus-visible` outline that Chromium
 * paints by default has regressed twice now (once pre-D087 and once
 * during the staged-patch UX pass) — the rule "focus state is a
 * subtle bg-background-element shift, NOT a default outline ring"
 * needs a hard assertion so a casual refactor doesn't bring it back.
 *
 * Invariants (enforced by tests/unit/file-tree-row-class.test.ts):
 *   1. Always suppresses `outline`, `focus:outline`, `focus-visible:outline`,
 *      and `focus-visible:ring`. This is the anti-regression core.
 *   2. Focused === true sets `bg-background-element` (the subtle cue).
 *   3. Focused === false omits that class so rows revert cleanly.
 *   4. Hover always gives `hover:bg-background-element` regardless of
 *      focus so mouse discovery still works.
 */
export function buildFileRowClass(focused: boolean, selected = false): string {
  return [
    "flex h-full w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-background-element",
    "outline-none focus:outline-none focus-visible:outline-none focus-visible:ring-0",
    selected ? "border-l-2 border-accent bg-[var(--tree-row-active)]" : "border-l-2 border-transparent",
    focused ? "bg-[var(--tree-row-active)]" : "",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Entry {
  name: string;
  path: string;
  type: "file" | "directory";
  expanded: boolean;
  childrenPaths: string[] | null;
  childrenTotal?: number;
  /** From the desktop readDir bridge; used for date/size sort. */
  mtimeMs?: number;
  sizeBytes?: number;
}

type ReadDirResult =
  | { ok: true; children: Entry[]; total: number }
  | { ok: false; error: string };

type EntriesMap = ReadonlyMap<string, Entry>;

export type FileSortMode = "name" | "modified" | "size";
export type FileSortDir = "asc" | "desc";

export interface FileSortConfig {
  mode: FileSortMode;
  dir: FileSortDir;
  /** Pin directories above files regardless of the active field. */
  foldersFirst: boolean;
}

/**
 * Comparator used by the render walk (not at read time) so toggling sort is
 * instant and never re-hits disk. `foldersFirst` short-circuits the field
 * compare; otherwise files and folders interleave by the chosen field. Name is
 * always the stable tiebreaker so equal dates/sizes don't shuffle.
 */
export function compareEntries(a: Entry, b: Entry, cfg: FileSortConfig): number {
  if (cfg.foldersFirst && a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  let cmp = 0;
  switch (cfg.mode) {
    case "modified":
      cmp = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
      break;
    case "size":
      cmp = (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
      break;
    case "name":
    default:
      cmp = a.name.localeCompare(b.name);
      break;
  }
  if (cmp === 0) cmp = a.name.localeCompare(b.name);
  return cfg.dir === "asc" ? cmp : -cmp;
}

function isEntryVisible(args: {
  name: string;
  relPosix: string;
  isDirectory: boolean;
  showHidden: boolean;
  gitignore: Ignore | null;
}): boolean {
  if (IGNORE_NAMES.has(args.name)) return false;
  for (const re of IGNORE_PATTERNS) {
    if (re.test(args.name)) return false;
  }
  if (!args.showHidden && args.name.startsWith(".")) return false;
  if (args.gitignore) {
    const rel = args.isDirectory ? `${args.relPosix}/` : args.relPosix;
    if (args.gitignore.ignores(rel)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export type FileTreeEmptyState = "empty-folder" | "genie-workspace";

export type FileTreeViewProps = {
  rootPath: string;
  /**
   * Root read error UI: second action ("Change workspace…" → current-folder picker).
   * Omit on the Genie Workspace tab until `setRoot` / `pickAndSetRoot` exists.
   */
  onChooseFolderOnError?: () => void;
  dataTestId: string;
  treeAriaLabel: string;
  searchPlaceholder?: string;
  emptyState: FileTreeEmptyState;
  /**
   * When true (default), clicking or pressing Enter on a file queues it as a
   * composer attachment. The Workspace tab sets false so the tree is
   * browse-only and does not touch the draft.
   */
  pasteFileIntoComposer?: boolean;
  onOpenFile?: (target: OpenFileTarget) => void;
  /** When provided, renders a "New" button in the action row (keeps the
   *  toolbar on one consistent strip instead of a separate parent row). */
  onNewFile?: () => void;
  /** When provided, renders a "New folder" button beside New file (Files tab). */
  onNewFolder?: () => void;
  /** Keeps Files-tab create-folder dialog aligned with focused tree row. */
  onCreateFolderContextChange?: (ctx: FileTreeCreateFolderContext) => void;
  /** After mkdir, expand this directory path once (parent of the new folder). */
  expandDirectoryPath?: string | null;
  onExpandDirectoryHandled?: () => void;
};

export function FileTreeView(props: FileTreeViewProps) {
  const {
    rootPath,
    onChooseFolderOnError,
    dataTestId,
    treeAriaLabel,
    searchPlaceholder = "Search files…",
    emptyState,
    pasteFileIntoComposer = true,
    onOpenFile,
    onNewFile,
    onNewFolder,
    onCreateFolderContextChange,
    expandDirectoryPath,
    onExpandDirectoryHandled,
  } = props;
  const [rootReadError, setRootReadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  return (
    <FileTreeViewInner
      rootPath={rootPath}
      rootReadError={rootReadError}
      onRootReadError={setRootReadError}
      query={query}
      onQueryChange={setQuery}
      onChooseFolderOnError={onChooseFolderOnError}
      dataTestId={dataTestId}
      treeAriaLabel={treeAriaLabel}
      searchPlaceholder={searchPlaceholder}
      emptyState={emptyState}
      pasteFileIntoComposer={pasteFileIntoComposer}
      onOpenFile={onOpenFile}
      onNewFile={onNewFile}
      onNewFolder={onNewFolder}
      onCreateFolderContextChange={onCreateFolderContextChange}
      expandDirectoryPath={expandDirectoryPath}
      onExpandDirectoryHandled={onExpandDirectoryHandled}
    />
  );
}

function FileTreeViewInner(props: {
  rootPath: string;
  rootReadError: string | null;
  onRootReadError: (s: string | null) => void;
  query: string;
  onQueryChange: (s: string) => void;
  onChooseFolderOnError?: () => void;
  dataTestId: string;
  treeAriaLabel: string;
  searchPlaceholder: string;
  emptyState: FileTreeEmptyState;
  pasteFileIntoComposer: boolean;
  onOpenFile?: (target: OpenFileTarget) => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onCreateFolderContextChange?: (ctx: FileTreeCreateFolderContext) => void;
  expandDirectoryPath?: string | null;
  onExpandDirectoryHandled?: () => void;
}) {
  const subscribeWorkspaceArtifactEvents = useWorkspaceArtifactEventHub();
  const {
    rootPath,
    rootReadError,
    onRootReadError,
    query,
    onQueryChange,
    onChooseFolderOnError,
    dataTestId,
    treeAriaLabel,
    searchPlaceholder,
    emptyState,
    pasteFileIntoComposer,
    onOpenFile,
    onNewFile,
    onNewFolder,
    onCreateFolderContextChange,
    expandDirectoryPath,
    onExpandDirectoryHandled,
  } = props;
  const toast = useToast();
  const [entries, setEntries] = useState<EntriesMap>(() => new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<ReadonlyMap<string, string>>(new Map());
  const [rootPaths, setRootPaths] = useState<string[] | null>(null);
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_SHOW_HIDDEN) === "1";
    } catch {
      return false;
    }
  });
  const [gitignore, setGitignore] = useState<Ignore | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);

  const toggleShowHidden = useCallback(() => {
    setShowHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_SHOW_HIDDEN, next ? "1" : "0");
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  const [sortMode, setSortMode] = useState<FileSortMode>(() => {
    try {
      const v = localStorage.getItem(LS_SORT_MODE);
      return v === "modified" || v === "size" ? v : "name";
    } catch {
      return "name";
    }
  });
  const [sortDir, setSortDir] = useState<FileSortDir>(() => {
    try {
      return localStorage.getItem(LS_SORT_DIR) === "desc" ? "desc" : "asc";
    } catch {
      return "asc";
    }
  });
  const [foldersFirst, setFoldersFirst] = useState<boolean>(() => {
    try {
      // Default on (matches pre-D270-5 behavior) unless explicitly disabled.
      return localStorage.getItem(LS_FOLDERS_FIRST) !== "0";
    } catch {
      return true;
    }
  });
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  // Menu is rendered in a portal (below) so the browser column's overflow clip
  // can't truncate it when the panel is narrow. Position is fixed and anchored
  // to the trigger's rect, recomputed on open + resize/scroll.
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const sortBtnRef = useRef<HTMLButtonElement | null>(null);
  const [sortMenuPos, setSortMenuPos] = useState<{ top: number; left: number } | null>(null);

  const recomputeSortMenuPos = useCallback(() => {
    const r = sortBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Left-anchored to the trigger and clamped within the viewport. The browser
    // column is docked left, so a right-anchored menu would spill off the left
    // edge; opening rightward (and over the chat surface, which is why this is
    // a body portal) keeps the whole menu on-screen.
    const menuWidth = SORT_MENU_WIDTH_PX;
    const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
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

  const chooseSortMode = useCallback((mode: FileSortMode) => {
    setSortMode(mode);
    try {
      localStorage.setItem(LS_SORT_MODE, mode);
    } catch {
      /* noop */
    }
  }, []);
  const chooseSortDir = useCallback((dir: FileSortDir) => {
    setSortDir(dir);
    try {
      localStorage.setItem(LS_SORT_DIR, dir);
    } catch {
      /* noop */
    }
  }, []);
  const toggleFoldersFirst = useCallback(() => {
    setFoldersFirst((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_FOLDERS_FIRST, next ? "1" : "0");
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
      // The menu lives in a portal outside the trigger, so close only when the
      // click is outside BOTH the trigger button and the menu itself.
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
    // Capture-phase scroll so the menu tracks the trigger if any ancestor scrolls.
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [sortMenuOpen, recomputeSortMenuPos]);

  const sortConfig = useMemo<FileSortConfig>(
    () => ({ mode: sortMode, dir: sortDir, foldersFirst }),
    [sortMode, sortDir, foldersFirst],
  );

  useEffect(() => {
    if (!desktopAPI) return;
    let cancelled = false;
    void (async () => {
      try {
        const gitignorePath = joinPath(rootPath, ".gitignore");
        const stat = await desktopAPI.fs.stat(gitignorePath);
        if (!stat.exists || !stat.isFile) {
          if (!cancelled) setGitignore(null);
          return;
        }
        const contents = await desktopAPI.fs.readFile(gitignorePath);
        if (cancelled) return;
        const instance = ignore().add(contents);
        setGitignore(instance);
      } catch {
        if (!cancelled) setGitignore(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const markLoading = useCallback((p: string, v: boolean) => {
    setLoading((prev) => {
      const next = new Set(prev);
      if (v) next.add(p);
      else next.delete(p);
      return next;
    });
  }, []);

  const markError = useCallback((p: string, msg: string | null) => {
    setError((prev) => {
      const next = new Map(prev);
      if (msg) next.set(p, msg);
      else next.delete(p);
      return next;
    });
  }, []);

  const readDirectory = useCallback(
    async (dirPath: string): Promise<ReadDirResult> => {
      if (!desktopAPI) {
        return { ok: false, error: "desktop bridge unavailable" };
      }
      try {
        const raw = await desktopAPI.fs.readDir(dirPath);
        const filtered = raw.filter((r) => {
          const childPath = joinPath(dirPath, r.name);
          const rel = relativeFromWorkspace(rootPath, childPath);
          const relPosix = rel.replace(/\\/g, "/");
          return isEntryVisible({
            name: r.name,
            relPosix,
            isDirectory: r.type === "directory",
            showHidden,
            gitignore,
          });
        });
        // No entry cap: the tree is fully virtualized (@tanstack/react-virtual),
        // so render cost is bounded by the viewport, not the directory size. The
        // previous `slice(0, 500)` ran in raw readdir order *before* the sort,
        // which silently dropped entries (and made them unsearchable) — e.g. a
        // large ~/Downloads showed only an arbitrary OS-ordered prefix.
        //
        // Order is NOT decided here: the render walk sorts via `compareEntries`
        // using the live sort config, so toggling sort never re-hits disk.
        const total = filtered.length;
        const children: Entry[] = filtered.map<Entry>((r) => ({
          name: r.name,
          path: joinPath(dirPath, r.name),
          type: r.type === "directory" ? "directory" : "file",
          expanded: false,
          childrenPaths: null,
          mtimeMs: r.mtimeMs,
          sizeBytes: r.sizeBytes,
        }));
        return { ok: true, children, total };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markError(dirPath, msg);
        return { ok: false, error: msg };
      }
    },
    [markError, rootPath, showHidden, gitignore],
  );

  useEffect(() => {
    let cancelled = false;
    setEntries(new Map());
    setRootPaths(null);
    void (async () => {
      markLoading(rootPath, true);
      onRootReadError(null);
      const result = await readDirectory(rootPath);
      if (cancelled) return;
      markLoading(rootPath, false);
      if (!result.ok) {
        onRootReadError(result.error);
        setRootPaths([]);
        return;
      }
      setEntries((prev) => {
        const next = new Map(prev);
        for (const c of result.children) next.set(c.path, c);
        return next;
      });
      setRootPaths(result.children.map((c) => c.path));
    })();
    return () => {
      cancelled = true;
    };
  }, [rootPath, markLoading, onRootReadError, readDirectory]);

  const toggleExpand = useCallback(
    async (entryPath: string) => {
      const entry = entries.get(entryPath);
      if (!entry || entry.type !== "directory") return;

      if (entry.expanded) {
        setEntries((prev) => {
          const next = new Map(prev);
          next.set(entryPath, { ...entry, expanded: false });
          return next;
        });
        return;
      }

      markLoading(entryPath, true);
      markError(entryPath, null);
      const result = await readDirectory(entryPath);
      markLoading(entryPath, false);
      if (!result.ok) return;

      setEntries((prev) => {
        const next = new Map(prev);
        for (const c of result.children) {
          if (!next.has(c.path)) next.set(c.path, c);
        }
        next.set(entryPath, {
          ...entry,
          expanded: true,
          childrenPaths: result.children.map((c) => c.path),
          childrenTotal: result.total,
        });
        return next;
      });
    },
    [entries, markError, markLoading, readDirectory],
  );

  const refreshDirectory = useCallback(
    async (dirPath: string) => {
      markLoading(dirPath, true);
      markError(dirPath, null);
      const result = await readDirectory(dirPath);
      markLoading(dirPath, false);
      if (!result.ok) {
        if (dirPath === rootPath) onRootReadError(result.error);
        return;
      }

      setEntries((prev) => {
        const next = new Map(prev);
        const previous = next.get(dirPath);
        for (const c of result.children) {
          const existing = next.get(c.path);
          next.set(c.path, existing && existing.type === c.type
            ? { ...c, expanded: existing.expanded, childrenPaths: existing.childrenPaths, childrenTotal: existing.childrenTotal }
            : c);
        }
        const nextChildren = new Set(result.children.map((c) => c.path));
        if (previous?.childrenPaths) {
          for (const oldChild of previous.childrenPaths) {
            if (!nextChildren.has(oldChild)) next.delete(oldChild);
          }
        }
        if (dirPath !== rootPath && previous) {
          next.set(dirPath, {
            ...previous,
            expanded: previous.expanded,
            childrenPaths: result.children.map((c) => c.path),
            childrenTotal: result.total,
          });
        }
        return next;
      });
      if (dirPath === rootPath) {
        onRootReadError(null);
        setRootPaths(result.children.map((c) => c.path));
      }
    },
    [markError, markLoading, onRootReadError, readDirectory, rootPath],
  );

  const refreshOpenDirectories = useCallback(
    async (changedPath?: string) => {
      const dirs = new Set<string>([rootPath]);
      for (const entry of entries.values()) {
        if (entry.type !== "directory" || !entry.expanded) continue;
        if (!changedPath || isUnderRoot(entry.path, changedPath) || isUnderRoot(changedPath, entry.path)) {
          dirs.add(entry.path);
        }
      }
      await Promise.all(Array.from(dirs).map((dir) => refreshDirectory(dir)));
    },
    [entries, refreshDirectory, rootPath],
  );

  const retryRoot = useCallback(async () => {
    await refreshDirectory(rootPath);
  }, [refreshDirectory, rootPath]);

  const liveRefreshTimerRef = useRef<number | null>(null);
  const scheduleLiveRefresh = useCallback(
    (changedPath?: string) => {
      if (liveRefreshTimerRef.current !== null) {
        window.clearTimeout(liveRefreshTimerRef.current);
      }
      liveRefreshTimerRef.current = window.setTimeout(() => {
        liveRefreshTimerRef.current = null;
        void refreshOpenDirectories(changedPath);
      }, LIVE_REFRESH_DEBOUNCE_MS);
    },
    [refreshOpenDirectories],
  );

  // D448 local mutations publish a durable committed event through the shared
  // event hub. They intentionally do not also emit a generic fs watcher event,
  // so the Files tree must consume the committed path directly. This keeps a
  // newly created agent output visible without requiring focus churn or a
  // manual refresh while preserving one canonical publication signal.
  useEffect(() => {
    return subscribeWorkspaceArtifactEvents((event) => {
      const refreshPath = localCommittedMutationRefreshPath(event, rootPath);
      if (refreshPath) scheduleLiveRefresh(refreshPath);
    }, {
      onReconnect: () => scheduleLiveRefresh(),
    });
  }, [rootPath, scheduleLiveRefresh, subscribeWorkspaceArtifactEvents]);

  useEffect(() => {
    const api = desktopAPI;
    if (!api?.fs.watchRoot || !api.fs.onDirectoryChanged) return;
    let cancelled = false;
    void api.fs.watchRoot(rootPath).catch((err) => {
      console.warn("[file-tree] failed to watch root:", err);
    });
    const unsubscribe = api.fs.onDirectoryChanged((event) => {
      if (cancelled) return;
      if (!isUnderRoot(rootPath, event.rootPath) && !isUnderRoot(event.rootPath, rootPath)) return;
      if (!isUnderRoot(rootPath, event.path)) return;
      scheduleLiveRefresh(event.path);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      void api.fs.unwatchRoot(rootPath).catch(() => {});
    };
  }, [rootPath, scheduleLiveRefresh]);

  useEffect(() => {
    const refreshOnFocus = () => scheduleLiveRefresh();
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") scheduleLiveRefresh();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      if (liveRefreshTimerRef.current !== null) {
        window.clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
    };
  }, [scheduleLiveRefresh]);

  const toolEvents = useToolActivity();
  const citedPaths = useMemo<ReadonlySet<string>>(
    () => derivedCitedPaths(toolEvents, rootPath),
    [toolEvents, rootPath],
  );

  const [lastMessage, setLastMessage] = useState<string | null>(null);

  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const visibleRows = useMemo<RenderRow[]>(() => {
    if (!rootPaths) return [];
    const q = debouncedQuery.trim().toLowerCase();

    let forcedVisible: Set<string> | null = null;
    if (q) {
      const matches: string[] = [];
      for (const entry of entries.values()) {
        if (entry.name.toLowerCase().includes(q)) matches.push(entry.path);
      }
      forcedVisible = new Set(matches);
      const rootLen = rootPath.length;
      for (const m of matches) {
        let p = m;
        while (p.length > rootLen) {
          const slashIdx = p.lastIndexOf("/");
          if (slashIdx <= 0) break;
          p = p.slice(0, slashIdx);
          if (p.length < rootLen) break;
          forcedVisible.add(p);
          if (p === rootPath) break;
        }
      }
    }

    // Sort at render time (not read time) so changing sort never re-hits disk.
    const sortPaths = (paths: readonly string[]): string[] =>
      paths
        .map((p) => entries.get(p))
        .filter((e): e is Entry => e !== undefined)
        .sort((a, b) => compareEntries(a, b, sortConfig))
        .map((e) => e.path);

    const rows: RenderRow[] = [];
    const walk = (path: string, depth: number) => {
      const e = entries.get(path);
      if (!e) return;

      if (forcedVisible && !forcedVisible.has(path)) return;

      rows.push({ entry: e, depth });

      if (e.type !== "directory" || !e.childrenPaths) return;

      const shouldDescend = forcedVisible ? true : e.expanded;
      if (!shouldDescend) return;
      for (const c of sortPaths(e.childrenPaths)) walk(c, depth + 1);
    };

    for (const p of sortPaths(rootPaths)) walk(p, 0);
    return rows;
  }, [rootPaths, entries, debouncedQuery, rootPath, sortConfig]);

  const selectRange = useCallback(
    (fromPath: string, toPath: string) => {
      const fromIndex = visibleRows.findIndex((r) => r.entry.path === fromPath);
      const toIndex = visibleRows.findIndex((r) => r.entry.path === toPath);
      if (fromIndex < 0 || toIndex < 0) {
        setSelectedPaths(new Set([toPath]));
        setSelectionAnchor(toPath);
        return;
      }
      const [start, end] =
        fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
      const next = new Set<string>();
      for (let i = start; i <= end; i++) {
        const row = visibleRows[i];
        if (row?.entry.type === "file") next.add(row.entry.path);
      }
      setSelectedPaths(next);
      setSelectionAnchor(fromPath);
    },
    [visibleRows],
  );

  const toggleSelected = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setSelectionAnchor(path);
  }, []);

  const onFileClick = useCallback(
    (
      entry: Entry,
      event: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
    ) => {
      if (event.metaKey || event.ctrlKey) {
        toggleSelected(entry.path);
        setLastMessage(null);
        return;
      }
      if (event.shiftKey) {
        selectRange(selectionAnchor ?? entry.path, entry.path);
        setLastMessage(null);
        return;
      }
      if (!event.altKey && onOpenFile) {
        onOpenFile(fsOpenFileTarget(entry.path, rootPath));
        setSelectedPaths(new Set());
        setSelectionAnchor(entry.path);
        setLastMessage(null);
        return;
      }
      if (!pasteFileIntoComposer) return;
      const r = queueFileAttachmentFromPath(entry.path, rootPath);
      if (!r.ok) {
        if ("code" in r && r.code === "unsupported") {
          const { title, message } = formatComposerAttachmentSkipToast([r.skip]);
          toast.show({ variant: "warning", title, message });
          setLastMessage(null);
        } else if ("message" in r) {
          setLastMessage(r.message);
        }
      } else {
        setLastMessage(null);
      }
    },
    [rootPath, pasteFileIntoComposer, onOpenFile, selectRange, selectionAnchor, toggleSelected, toast],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT_PX,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => visibleRows[index]?.entry.path ?? index,
  });

  const [focusedIndex, setFocusedIndex] = useState(0);
  // Distinguishes "user actively focused/clicked a row" from the default
  // focusedIndex=0 on mount, so "New folder" with no interaction targets the
  // current-folder root instead of silently nesting inside the first row (D357).
  const [hasFocusInteraction, setHasFocusInteraction] = useState(false);
  useEffect(() => {
    if (visibleRows.length === 0) return;
    setFocusedIndex((prev) => {
      if (prev < 0) return 0;
      if (prev >= visibleRows.length) return visibleRows.length - 1;
      return prev;
    });
  }, [visibleRows.length]);

  // Switching the current folder is not an explicit row choice — reset so a
  // fresh root's "New folder" defaults to root until the user picks a row.
  useEffect(() => {
    setHasFocusInteraction(false);
  }, [rootPath]);

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

  useEffect(() => {
    if (!onCreateFolderContextChange) return;
    const parentPath = resolveCreateFolderParent({
      focusedRow: hasFocusInteraction ? visibleRows[focusedIndex] : undefined,
      rootPath,
      selectedPaths,
      entries,
    });
    onCreateFolderContextChange({
      parentPath,
      siblingNames: collectSiblingNamesAt(entries, parentPath, rootPath, rootPaths),
    });
  }, [
    entries,
    focusedIndex,
    hasFocusInteraction,
    onCreateFolderContextChange,
    rootPath,
    rootPaths,
    selectedPaths,
    visibleRows,
  ]);

  useEffect(() => {
    if (!expandDirectoryPath) return;
    const pathToExpand = expandDirectoryPath;
    onExpandDirectoryHandled?.();
    void (async () => {
      const entry = entries.get(pathToExpand);
      if (entry?.type === "directory" && !entry.expanded) {
        await toggleExpand(pathToExpand);
      }
    })();
  }, [expandDirectoryPath, entries, onExpandDirectoryHandled, toggleExpand]);

  const [dragSource, setDragSource] = useState<FileTreeMovePayload | null>(null);
  const [dragOverDirPath, setDragOverDirPath] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);

  const clearDragState = useCallback(() => {
    setDragSource(null);
    setDragOverDirPath(null);
    setDragOverRoot(false);
  }, []);

  const canDropOnDirectory = useCallback(
    (targetDirPath: string, source: FileTreeMovePayload | null): boolean => {
      if (!source) return false;
      if (source.path === targetDirPath) return false;
      if (parentDirectoryPath(source.path, rootPath) === targetDirPath) return true;
      if (source.type === "directory" && isCyclicFolderMove(source.path, targetDirPath)) {
        return false;
      }
      return true;
    },
    [rootPath],
  );

  const handleInternalMove = useCallback(
    async (source: FileTreeMovePayload, toDirPath: string) => {
      if (!desktopAPI?.fs.rename) {
        toast.show({
          variant: "warning",
          title: "Move unavailable",
          message: "Desktop file move is not available in this environment.",
        });
        return;
      }
      const result = await executeFileTreeMove({
        rename: desktopAPI.fs.rename.bind(desktopAPI.fs),
        fromPath: source.path,
        fromType: source.type,
        toDirPath,
      });
      if (result.ok) return;
      if (result.reason === "noop") return;
      if (result.reason === "cyclic") {
        toast.show({
          variant: "warning",
          title: "Cannot move",
          message: result.message ?? "Cannot move a folder into itself or its subfolder.",
        });
        return;
      }
      const err = formatFsMoveError(result.reason, result.message);
      toast.show({ variant: "warning", title: err.title, message: err.message });
    },
    [toast],
  );

  const [deleteTarget, setDeleteTarget] = useState<
    { path: string; type: "file" | "directory" } | null
  >(null);

  const requestDeleteFocused = useCallback(() => {
    // Only delete a row the user actively focused (same gate as create-folder),
    // never the default focusedIndex=0 row.
    if (!hasFocusInteraction) return;
    const row = visibleRows[focusedIndex];
    if (!row) return;
    setDeleteTarget({ path: row.entry.path, type: row.entry.type });
  }, [focusedIndex, hasFocusInteraction, visibleRows]);

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    if (!desktopAPI?.fs.trash) {
      toast.show({
        variant: "warning",
        title: "Delete unavailable",
        message: "Desktop file delete is not available in this environment.",
      });
      return;
    }
    const result = await executeFileTreeTrash({
      trash: desktopAPI.fs.trash.bind(desktopAPI.fs),
      path: target.path,
    });
    if (!result.ok) {
      const err = formatFsTrashError(result.code, result.message);
      toast.show({ variant: "warning", title: err.title, message: err.message });
    }
    // Success: the directory watcher refreshes the tree (no manual reload).
  }, [deleteTarget, toast]);

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
          if (row.entry.type === "directory" && !row.entry.expanded) {
            void toggleExpand(row.entry.path);
          } else {
            focusRow(focusedIndex + 1);
          }
          return;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (!row) return;
          if (row.entry.type === "directory" && row.entry.expanded) {
            void toggleExpand(row.entry.path);
          } else {
            if (row.depth === 0) return;
            for (let i = focusedIndex - 1; i >= 0; i--) {
              const candidate = visibleRows[i];
              if (candidate && candidate.depth < row.depth) {
                focusRow(i);
                return;
              }
            }
          }
          return;
        }
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          requestDeleteFocused();
          return;
        }
        case "Enter": {
          e.preventDefault();
          if (!row) return;
          if (row.entry.type === "directory") void toggleExpand(row.entry.path);
          else void onFileClick(row.entry, {
            altKey: e.altKey,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
          });
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
            onQueryChange("");
          } else if (selectedPaths.size > 0) {
            e.preventDefault();
            setSelectedPaths(new Set());
            setSelectionAnchor(null);
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
      focusedIndex,
      visibleRows,
      focusRow,
      toggleExpand,
      onFileClick,
      query,
      onQueryChange,
      selectedPaths.size,
      requestDeleteFocused,
    ],
  );

  const handleSearchKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        if (query.length > 0) {
          e.preventDefault();
          onQueryChange("");
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
    [query, onQueryChange, visibleRows.length],
  );

  return (
    <div data-testid={dataTestId} className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <SearchBar
          ref={searchInputRef}
          value={query}
          onChange={onQueryChange}
          onKeyDown={handleSearchKeyDown}
          placeholder={searchPlaceholder}
        />
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        {onNewFile ? (
          <button
            type="button"
            onClick={onNewFile}
            aria-label="New file"
            title="New file"
            data-testid="files-tab-new-file"
            className="shrink-0 rounded-md border border-border bg-background-element px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)]"
          >
            <Plus aria-hidden="true" size={12} className="mr-0.5 inline" />
            New
          </button>
        ) : null}
        {onNewFolder ? (
          <button
            type="button"
            onClick={onNewFolder}
            aria-label="New folder"
            title="New folder"
            data-testid="files-tab-new-folder"
            className="shrink-0 rounded-md border border-border bg-background-element px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)]"
          >
            <FolderPlus aria-hidden="true" size={12} className="mr-0.5 inline" />
            Folder
          </button>
        ) : null}
        {desktopAPI?.fs.trash ? (
          <button
            type="button"
            onClick={requestDeleteFocused}
            aria-label="Move focused item to Trash"
            title="Move the focused file or folder to the OS Trash"
            data-testid="files-tab-delete"
            className="shrink-0 rounded-md border border-border bg-background-element px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-[var(--primary-muted)]"
          >
            <Trash2 aria-hidden="true" size={12} className="mr-0.5 inline" />
            Trash
          </button>
        ) : null}
        <div className="shrink-0">
          <button
            ref={sortBtnRef}
            type="button"
            onClick={toggleSortMenu}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            aria-label="Sort files"
            title="Sort files"
            className="rounded-md p-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
          >
            <ArrowDownUp aria-hidden="true" size={14} />
          </button>
          {sortMenuOpen && sortMenuPos
            ? createPortal(
                <div
                  ref={sortMenuRef}
                  role="menu"
                  aria-label="Sort files"
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
                ] as ReadonlyArray<[FileSortMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sortMode === mode}
                  onClick={() => chooseSortMode(mode)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)] transition-colors"
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
                ] as ReadonlyArray<[FileSortDir, string, typeof ArrowUp]>
              ).map(([dir, label, Icon]) => (
                <button
                  key={dir}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sortDir === dir}
                  onClick={() => chooseSortDir(dir)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)] transition-colors"
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
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-[var(--primary-muted)] transition-colors"
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
          onClick={() => void refreshOpenDirectories()}
          aria-label="Refresh files"
          title="Refresh files"
          className="shrink-0 rounded-md p-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <RefreshCw aria-hidden="true" size={14} />
        </button>
        <button
          type="button"
          onClick={toggleShowHidden}
          aria-pressed={showHidden}
          aria-label={showHidden ? "Hide dot-files" : "Show dot-files"}
          title={
            showHidden
              ? "Hiding dot-files (click to show)"
              : "Showing dot-files (click to hide)"
          }
          className="shrink-0 rounded-md p-1 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          {showHidden ? (
            <Eye aria-hidden="true" size={14} />
          ) : (
            <EyeOff aria-hidden="true" size={14} />
          )}
        </button>
      </div>

      {rootReadError ? (
        <RootReadError
          message={rootReadError}
          onRetry={() => {
            void retryRoot();
          }}
          onChooseFolder={onChooseFolderOnError}
        />
      ) : rootPaths === null ? (
        <div className="flex h-full items-center justify-center">
          <span className="text-xs text-foreground-muted">Loading workspace…</span>
        </div>
      ) : rootPaths.length === 0 ? (
        <EmptyState variant={emptyState} />
      ) : visibleRows.length === 0 ? (
        <NoSearchMatches query={query} onClear={() => onQueryChange("")} />
      ) : (
        <VirtualTreeBody
          scrollRef={scrollRef}
          virtualizer={virtualizer}
          visibleRows={visibleRows}
          focusedIndex={focusedIndex}
          loading={loading}
          error={error}
          citedPaths={citedPaths}
          onFocusRow={(i) => {
            setHasFocusInteraction(true);
            setFocusedIndex(i);
          }}
          onToggle={(p) => {
            void toggleExpand(p);
          }}
          onFile={(e, ev) => {
            void onFileClick(e, ev);
          }}
          onKeyDown={onTreeKeyDown}
          treeAriaLabel={treeAriaLabel}
          treeRootPath={rootPath}
          selectedPaths={selectedPaths}
          dragSource={dragSource}
          dragOverDirPath={dragOverDirPath}
          dragOverRoot={dragOverRoot}
          canDropOnDirectory={canDropOnDirectory}
          onDragSourceChange={setDragSource}
          onDragOverDirPathChange={setDragOverDirPath}
          onDragOverRootChange={setDragOverRoot}
          onClearDragState={clearDragState}
          onInternalMove={(source, toDirPath) => {
            void handleInternalMove(source, toDirPath);
          }}
        />
      )}

      {lastMessage && (
        <div className="border-t border-border px-3 py-2 text-[11px] text-foreground-muted">
          {lastMessage}
        </div>
      )}

      {deleteTarget ? (
        <ConfirmDialog
          title={deleteTarget.type === "directory" ? "Move folder to Trash?" : "Move file to Trash?"}
          body={`Move ${deleteTarget.path} to the Trash? You can restore it from your operating system's Trash.`}
          confirmLabel="Move to Trash"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  );
}

function VirtualTreeBody(props: {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  visibleRows: readonly RenderRow[];
  focusedIndex: number;
  loading: ReadonlySet<string>;
  error: ReadonlyMap<string, string>;
  citedPaths: ReadonlySet<string>;
  onFocusRow: (i: number) => void;
  onToggle: (p: string) => void;
  onFile: (
    e: Entry,
    event: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  treeAriaLabel: string;
  treeRootPath: string;
  selectedPaths: ReadonlySet<string>;
  dragSource: FileTreeMovePayload | null;
  dragOverDirPath: string | null;
  dragOverRoot: boolean;
  canDropOnDirectory: (targetDirPath: string, source: FileTreeMovePayload | null) => boolean;
  onDragSourceChange: (source: FileTreeMovePayload | null) => void;
  onDragOverDirPathChange: (path: string | null) => void;
  onDragOverRootChange: (active: boolean) => void;
  onClearDragState: () => void;
  onInternalMove: (source: FileTreeMovePayload, toDirPath: string) => void;
}) {
  const {
    scrollRef,
    virtualizer,
    visibleRows,
    focusedIndex,
    loading,
    error,
    citedPaths,
    onFocusRow,
    onToggle,
    onFile,
    onKeyDown,
    treeAriaLabel,
    treeRootPath,
    selectedPaths,
    dragSource,
    dragOverDirPath,
    dragOverRoot,
    canDropOnDirectory,
    onDragSourceChange,
    onDragOverDirPathChange,
    onDragOverRootChange,
    onClearDragState,
    onInternalMove,
  } = props;

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const onRootDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileTreeMovePayload(e.dataTransfer) && !dragSource) return;
    if (!dragSource) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOverRootChange(true);
    onDragOverDirPathChange(null);
  };

  const onRootDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    onDragOverRootChange(false);
  };

  const onRootDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    onClearDragState();
    const payload = readFileTreeMovePayload(e.dataTransfer) ?? dragSource;
    if (!payload) return;
    onInternalMove(payload, treeRootPath);
  };

  return (
    <div
      ref={scrollRef}
      className={[
        "min-h-0 flex-1 overflow-y-auto py-1 focus:outline-none",
        dragOverRoot ? "ring-2 ring-inset ring-accent/60" : "",
      ].join(" ")}
      tabIndex={0}
      role="tree"
      aria-label={treeAriaLabel}
      onKeyDown={onKeyDown}
      onDragOver={onRootDragOver}
      onDragLeave={onRootDragLeave}
      onDrop={onRootDrop}
    >
      <div
        className="relative w-full text-xs"
        style={{ height: `${totalSize}px` }}
      >
        {items.map((v) => {
          const row = visibleRows[v.index];
          if (!row) return null;
          return (
            <div
              key={row.entry.path}
              data-index={v.index}
              className="absolute left-0 right-0 top-0"
              style={{
                transform: `translateY(${v.start}px)`,
                height: `${v.size}px`,
              }}
            >
              <FileRow
                row={row}
                focused={v.index === focusedIndex}
                loading={loading.has(row.entry.path)}
                errorMessage={error.get(row.entry.path) ?? null}
                cited={citedPaths.has(row.entry.path)}
                selected={selectedPaths.has(row.entry.path)}
                selectedFileRefs={Array.from(selectedPaths).map((path) => ({
                  path,
                  rootPath: treeRootPath,
                }))}
                onFocus={() => onFocusRow(v.index)}
                onToggle={() => onToggle(row.entry.path)}
                onFile={(event) => onFile(row.entry, event)}
                treeRootPath={treeRootPath}
                dragSource={dragSource}
                dragOver={row.entry.type === "directory" && dragOverDirPath === row.entry.path}
                canDropOnDirectory={canDropOnDirectory}
                onDragSourceChange={onDragSourceChange}
                onDragOverDirPathChange={onDragOverDirPathChange}
                onDragOverRootChange={onDragOverRootChange}
                onClearDragState={onClearDragState}
                onInternalMove={onInternalMove}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NoSearchMatches({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-xs text-foreground-muted">
        No files match &ldquo;{query}&rdquo;.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-md border border-border bg-background-element px-2 py-1 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
      >
        Clear search
      </button>
      <p className="max-w-[18rem] text-[11px] text-foreground-muted">
        Search only matches files that have been loaded. Expand a folder to
        include its contents.
      </p>
    </div>
  );
}

interface RenderRow {
  entry: Entry;
  depth: number;
}

function FileRow(props: {
  row: RenderRow;
  focused: boolean;
  loading: boolean;
  errorMessage: string | null;
  cited: boolean;
  selected: boolean;
  selectedFileRefs: Array<{ path: string; rootPath: string }>;
  onFocus: () => void;
  onToggle: () => void;
  onFile: (event: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  treeRootPath: string;
  dragSource: FileTreeMovePayload | null;
  dragOver: boolean;
  canDropOnDirectory: (targetDirPath: string, source: FileTreeMovePayload | null) => boolean;
  onDragSourceChange: (source: FileTreeMovePayload | null) => void;
  onDragOverDirPathChange: (path: string | null) => void;
  onDragOverRootChange: (active: boolean) => void;
  onClearDragState: () => void;
  onInternalMove: (source: FileTreeMovePayload, toDirPath: string) => void;
}) {
  const {
    row,
    focused,
    loading,
    errorMessage,
    cited,
    selected,
    selectedFileRefs,
    onFocus,
    onToggle,
    onFile,
    treeRootPath,
    dragSource,
    dragOver,
    canDropOnDirectory,
    onDragSourceChange,
    onDragOverDirPathChange,
    onDragOverRootChange,
    onClearDragState,
    onInternalMove,
  } = props;
  const { entry, depth } = row;

  const indent = { paddingLeft: `${8 + depth * 14}px` };
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onFocus();
    if (entry.type === "directory") onToggle();
    else onFile({
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    });
  };

  const onDragStart = (e: DragEvent<HTMLButtonElement>) => {
    const movePayload: FileTreeMovePayload = {
      kind: "file-tree",
      path: entry.path,
      type: entry.type,
    };
    setFileTreeMoveOnDragData(e, movePayload);
    onDragSourceChange(movePayload);
    if (entry.type === "file") {
      const files =
        selected && selectedFileRefs.length > 1 ?
          selectedFileRefs
        : [{ path: entry.path, rootPath: treeRootPath }];
      setNautiloFileRefOnDragData(
        e,
        files.length === 1 ? files[0] : { files },
      );
      // setNautiloFileRefOnDragData resets effectAllowed to "copy" (for the
      // composer attach). Restore "copyMove" so an intra-tree drop onto a
      // folder (dropEffect "move") is still accepted — otherwise the browser
      // forces dropEffect to "none" and the folder rejects the file. (D357)
      e.dataTransfer.effectAllowed = "copyMove";
    }
  };

  const onDragEnd = () => {
    onClearDragState();
  };

  const onDirDragOver = (e: DragEvent<HTMLButtonElement>) => {
    if (entry.type !== "directory") return;
    if (!hasFileTreeMovePayload(e.dataTransfer) && !dragSource) return;
    const source = dragSource;
    if (!canDropOnDirectory(entry.path, source)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    onDragOverRootChange(false);
    onDragOverDirPathChange(entry.path);
  };

  const onDirDragLeave = (e: DragEvent<HTMLButtonElement>) => {
    if (entry.type !== "directory") return;
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (dragOver) onDragOverDirPathChange(null);
  };

  const onDirDrop = (e: DragEvent<HTMLButtonElement>) => {
    if (entry.type !== "directory") return;
    e.preventDefault();
    e.stopPropagation();
    onClearDragState();
    const payload = readFileTreeMovePayload(e.dataTransfer) ?? dragSource;
    if (!payload || !canDropOnDirectory(entry.path, payload)) return;
    onInternalMove(payload, entry.path);
  };

  const rowClass = [
    buildFileRowClass(focused, selected),
    dragOver ? "ring-1 ring-inset ring-accent/60 bg-[var(--primary-muted)]" : "",
  ].join(" ");

  const fileHint =
    entry.type === "file"
      ? " — click to open, Option-click to quote, drag to attach"
      : "";
  const titleBase = errorMessage ?? entry.path;
  const rowTitle = titleBase + (entry.type === "file" ? fileHint : "");

  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={entry.type === "directory" ? entry.expanded : undefined}
      aria-selected={focused}
      tabIndex={-1}
      onClick={handleClick}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDirDragOver}
      onDragLeave={onDirDragLeave}
      onDrop={onDirDrop}
      data-path={entry.path}
      data-type={entry.type}
      data-cited={cited || undefined}
      data-focused={focused || undefined}
      className={rowClass}
      style={indent}
      title={rowTitle}
    >
      {entry.type === "directory" ? (
        entry.expanded ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-foreground-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-foreground-muted" aria-hidden="true" />
        )
      ) : (
        <FileText className="h-3 w-3 flex-shrink-0 text-foreground-muted" aria-hidden="true" />
      )}
      <span className="truncate">{entry.name}</span>
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
      {loading && (
        <span
          aria-label="loading"
          className="ml-1 text-[10px] text-foreground-muted"
        >
          …
        </span>
      )}
      {errorMessage && (
        <AlertTriangle
          className="ml-1 h-3 w-3 flex-shrink-0 text-[var(--warning)]"
          aria-label={errorMessage}
        />
      )}
    </button>
  );
}

function EmptyState({ variant }: { variant: FileTreeEmptyState }) {
  if (variant === "genie-workspace") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-xs text-foreground-muted">
          Workspace is empty. Your Genie will save drafts here as she works.
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-xs text-foreground-muted">(empty folder)</span>
    </div>
  );
}

function RootReadError({
  message,
  onRetry,
  onChooseFolder,
}: {
  message: string;
  onRetry: () => void;
  onChooseFolder?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangle className="h-5 w-5 text-[var(--warning)]" aria-hidden="true" />
      <p className="max-w-[16rem] text-xs text-foreground">{message}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border bg-background-element px-2 py-1 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
        >
          Retry
        </button>
        {onChooseFolder && (
          <button
            type="button"
            onClick={onChooseFolder}
            className="rounded-md border border-border bg-background-element px-2 py-1 text-[11px] text-foreground hover:bg-[var(--primary-muted)]"
          >
            Change workspace…
          </button>
        )}
      </div>
    </div>
  );
}
