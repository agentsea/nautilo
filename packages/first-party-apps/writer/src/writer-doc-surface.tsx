/**
 * WriterDocSurface — the Nautilo Writer chrome (D372 / Nautilo Office, P2.2).
 *
 * Re-implements the D362 office ribbon (`office-doc-surface.tsx`) but drives the
 * Wafflebase `EditorAPI` directly instead of Collabora postMessage/UNO — and in
 * PLAIN CSS (the mini-app is a sandboxed iframe, not the Tailwind workbench).
 * The Wafflebase canvas ships no toolbar, so this IS the formatting UI.
 *
 * Verb map (D362 sendUno → EditorAPI):
 *   Bold/Italic/… → applyStyle({…})   ·  Clear → clearInlineFormatting()
 *   Para style     → setBlockType(type,{headingLevel})
 *   Font/size      → applyStyle({fontFamily|fontSize})
 *   Lists          → toggleList("ordered"|"unordered")
 *   Align          → applyBlockStyle({textAlign})
 *   Indent         → indent()/outdent()   ·  Undo/Redo → undo()/redo()
 *   Table/Link/Img → insertTable/insertLink/insertImage
 *   Table (in-cell)  → insert/delete row/col, merge/split, cell fill, deleteTable
 * Live toggle state (§3.3.6) comes from onCursorMove → getRangeStyleSummary()
 * + getBlockType() + getBlockStyle() (fires after style mutations too).
 *
 * Host chrome (close / chat / rename) lives in the workbench OUTSIDE the iframe,
 * so this header carries only title + save status. Comments and zoom are deferred
 * (see phase-2 doc) and intentionally not rendered. Find & replace is wired through
 * the engine's `onFindRequest` / `onFindReplaceRequest` + `setSearchMatches` API.
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type JSX, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  Baseline, Bold, CaseSensitive, ChevronLeft, ChevronRight, Highlighter, Image as ImageIcon,
  IndentDecrease, IndentIncrease, Italic, Link as LinkIcon, List, ListOrdered, type LucideIcon,
  Merge, Moon, Redo2, Regex as RegexIcon, RemoveFormatting, Replace, Search,
  SplitSquareHorizontal, Strikethrough, Subscript, Sun, Superscript, Table as TableIcon,
  Trash2, Underline, Undo2,
} from "lucide-react";
import {
  FindReplaceState, initialize, MemDocStore, setThemeMode, type BlockType, type EditorAPI,
  type TableMergeContext, type ThemeMode,
} from "@nautilo/office-docs/browser";
import { attachWriterSpellcheck, ignoreWriterSpellWord, setWriterSpellcheckEnabled, setWriterSpellcheckPersonalWords, type WriterSpellMenuRequest } from "./writer-spellcheck";
import { WriterSpellMenu } from "./writer-spell-menu";
import {
  selectedSuggestionChanges,
  type PendingSuggestionState,
  type SuggestionState,
} from "./suggestion-controller";
import { buildReviewProjection, reviewSurfaceState } from "./review-projection";
import { resolveReviewFocusRanges, scheduleReviewFocus } from "./review-focus";

export type WriterSaveStatus = "idle" | "saving" | "saved" | "unsaved" | "conflict" | "failed";

/**
 * Theme for the ribbon's body-portaled popovers. Popovers render via
 * `createPortal(..., document.body)`, so they live OUTSIDE `.writer-app` in the
 * DOM and the `.writer-app[data-theme="dark"] …` rules can't reach them. React
 * context still flows through portals (by tree, not DOM), so `AnchoredPopover`
 * reads this and stamps `data-theme` on the `.wr-popover` itself.
 */
const PopoverThemeContext = createContext<ThemeMode>("light");

interface ToolbarState {
  bold: boolean; italic: boolean; underline: boolean; strikethrough: boolean;
  superscript: boolean; subscript: boolean;
  fontFamily: string; fontSize: string;
  color: string | null; backgroundColor: string | null;
  paraValue: string; // "" | "title" | "subtitle" | "h1" | "h2" | "h3"
  listKind: "ordered" | "unordered" | null;
  alignment: string;
}

interface TableToolbarState {
  inTable: boolean;
  mergeContext: TableMergeContext;
}

const EMPTY_TABLE_STATE: TableToolbarState = { inTable: false, mergeContext: { state: "none" } };

const EMPTY_STATE: ToolbarState = {
  bold: false, italic: false, underline: false, strikethrough: false,
  superscript: false, subscript: false, fontFamily: "", fontSize: "",
  color: null, backgroundColor: null, paraValue: "", listKind: null, alignment: "left",
};

const PARAGRAPH_STYLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Normal" },
  { value: "title", label: "Title" },
  { value: "subtitle", label: "Subtitle" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
];

const FONT_FAMILIES: readonly string[] = [
  "Calibri", "Arial", "Times New Roman", "Georgia", "Courier New", "Verdana", "Noto Sans",
];
const FONT_SIZES: readonly string[] = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "32", "36", "48", "72"];

const COLOR_SWATCHES: readonly string[] = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#efefef", "#ffffff",
  "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#9900ff", "#ff00ff",
  "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6", "#674ea7", "#a64d79",
];

function readToolbarState(editor: EditorAPI): ToolbarState {
  const s = editor.getRangeStyleSummary();
  const b = editor.getBlockType();
  const bs = editor.getBlockStyle();
  const paraValue =
    b.type === "heading"
      ? `h${b.headingLevel ?? 1}`
      : b.type === "title" || b.type === "subtitle"
        ? b.type
        : "";
  return {
    bold: s.bold === true, italic: s.italic === true, underline: s.underline === true,
    strikethrough: s.strikethrough === true, superscript: s.superscript === true, subscript: s.subscript === true,
    fontFamily: typeof s.fontFamily === "string" ? s.fontFamily : "",
    fontSize: typeof s.fontSize === "number" ? String(s.fontSize) : "",
    color: typeof s.color === "string" ? s.color : null,
    backgroundColor: typeof s.backgroundColor === "string" ? s.backgroundColor : null,
    paraValue,
    listKind: b.type === "list-item" ? (b.listKind ?? "unordered") : null,
    alignment: typeof bs.alignment === "string" ? bs.alignment : "left",
  };
}

function readTableState(editor: EditorAPI): TableToolbarState {
  const inTable = editor.isInTable();
  return {
    inTable,
    mergeContext: inTable ? editor.getTableMergeContext() : { state: "none" },
  };
}

function statusLabel(s: WriterSaveStatus): string {
  switch (s) {
    case "saving": return "Saving…";
    case "saved": return "Saved";
    case "unsaved": return "Unsaved";
    case "conflict": return "Conflict";
    case "failed": return "Failed";
    default: return "";
  }
}

function AnchoredPopover({
  open, onClose, anchorRef, align = "left", children,
}: {
  open: boolean; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null>;
  align?: "left" | "right"; children: ReactNode;
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);
  if (!open || !pos) return null;
  const style: React.CSSProperties =
    align === "right"
      ? { position: "fixed", top: pos.top, right: pos.right, zIndex: 50 }
      : { position: "fixed", top: pos.top, left: pos.left, zIndex: 50 };
  return createPortal(
    <PopoverThemedPanel panelRef={panelRef} style={style}>{children}</PopoverThemedPanel>,
    document.body,
  );
}

/**
 * The portaled popover panel. Stamps the current theme onto its own element
 * (`data-theme`) so `.wr-popover[data-theme="dark"]` styling applies even
 * though the node lives at document.body, outside `.writer-app`.
 */
function PopoverThemedPanel({
  panelRef, style, children,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>; style: React.CSSProperties; children: ReactNode;
}): JSX.Element {
  const theme = useContext(PopoverThemeContext);
  return (
    <div ref={panelRef} role="menu" style={style} className="wr-popover" data-theme={theme}>
      {children}
    </div>
  );
}

function ToolButton({
  title, Icon, active = false, disabled = false, onClick,
}: {
  title: string; Icon: LucideIcon; active?: boolean; disabled?: boolean; onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={`wr-btn${active ? " wr-btn--active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon aria-hidden="true" className="wr-icon" />
    </button>
  );
}

function RibbonGroup({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="wr-group">
      <span className="wr-group__label">{label}</span>
      <div className="wr-group__row">{children}</div>
    </div>
  );
}

/**
 * Font-size control: a preset datalist PLUS free numeric entry (the engine's
 * `applyStyle({ fontSize })` accepts any positive number). Commits on blur or
 * Enter; reverts to the live value on an invalid entry. `draft` mirrors the
 * live selection style so moving the caret updates the shown size.
 */
function FontSizeControl({
  disabled, value, onCommit,
}: {
  disabled: boolean; value: string; onCommit: (size: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 1 && n <= 400) onCommit(n);
    else setDraft(value);
  };
  return (
    <>
      <input
        aria-label="Font size" title="Font size (type any number)" disabled={disabled}
        className="wr-select wr-select--size" list="wr-font-sizes" inputMode="numeric"
        placeholder="Size" value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); e.currentTarget.blur(); }
        }}
      />
      <datalist id="wr-font-sizes">
        {FONT_SIZES.map((s) => <option key={s} value={s} />)}
      </datalist>
    </>
  );
}

function ColorSwatchMenu({
  title, Icon, autoLabel, disabled, currentColor, onPick,
}: {
  title: string; Icon: LucideIcon; autoLabel: string; disabled: boolean;
  currentColor: string | null; onPick: (hex: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef} type="button" title={title} aria-label={title} aria-haspopup="true"
        aria-expanded={open} disabled={disabled} className={`wr-btn${open ? " wr-btn--active" : ""}`}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}
      >
        <span className="wr-color-icon">
          <Icon aria-hidden="true" className="wr-icon" />
          <span className="wr-color-bar" style={{ backgroundColor: currentColor ?? "transparent" }} />
        </span>
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <button type="button" className="wr-popover__auto" onClick={() => { onPick(null); setOpen(false); }}>
          {autoLabel}
        </button>
        <div className="wr-swatch-grid">
          {COLOR_SWATCHES.map((hex) => (
            <button
              key={hex} type="button" title={hex} aria-label={hex} className="wr-swatch"
              style={{ backgroundColor: hex }} onClick={() => { onPick(hex); setOpen(false); }}
            />
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}

function InsertTableMenu({ disabled, onInsert }: { disabled: boolean; onInsert: (rows: number, cols: number) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(2);
  const btnRef = useRef<HTMLButtonElement>(null);
  const clamp = (n: number) => Math.max(1, Math.min(20, Math.round(Number.isFinite(n) ? n : 1)));
  return (
    <>
      <button
        ref={btnRef} type="button" title="Insert table" aria-label="Insert table" aria-haspopup="true"
        aria-expanded={open} disabled={disabled} className={`wr-btn${open ? " wr-btn--active" : ""}`}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}
      >
        <TableIcon aria-hidden="true" className="wr-icon" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="wr-popover__row">
          <label className="wr-field">Cols
            <input type="number" min={1} max={20} value={cols} onChange={(e) => setCols(clamp(Number(e.target.value)))} className="wr-num" />
          </label>
          <label className="wr-field">Rows
            <input type="number" min={1} max={20} value={rows} onChange={(e) => setRows(clamp(Number(e.target.value)))} className="wr-num" />
          </label>
          <button type="button" className="wr-primary" onClick={() => { onInsert(clamp(rows), clamp(cols)); setOpen(false); }}>Insert</button>
        </div>
      </AnchoredPopover>
    </>
  );
}

function TableToolsMenu({
  disabled, mergeContext, onRowAbove, onRowBelow, onDeleteRow,
  onColLeft, onColRight, onDeleteCol, onMerge, onSplit, onCellFill, onDeleteTable,
}: {
  disabled: boolean;
  mergeContext: TableMergeContext;
  onRowAbove: () => void;
  onRowBelow: () => void;
  onDeleteRow: () => void;
  onColLeft: () => void;
  onColRight: () => void;
  onDeleteCol: () => void;
  onMerge: () => void;
  onSplit: () => void;
  onCellFill: (hex: string | null) => void;
  onDeleteTable: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const canMerge = mergeContext.state === "canMerge";
  const canSplit = mergeContext.state === "canUnmerge";
  const closeAnd = (fn: () => void) => () => { fn(); setOpen(false); };
  return (
    <>
      <button
        ref={btnRef} type="button" title="Table tools" aria-label="Table tools" aria-haspopup="true"
        aria-expanded={open} disabled={disabled} className={`wr-btn${open ? " wr-btn--active" : ""}`}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}
      >
        <TableIcon aria-hidden="true" className="wr-icon" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="wr-table-menu">
          <div className="wr-table-menu__section">Rows</div>
          <div className="wr-table-menu__row">
            <button type="button" className="wr-menu-btn" onClick={closeAnd(onRowAbove)}>
              <ArrowUp aria-hidden="true" className="wr-icon" /> Insert above
            </button>
            <button type="button" className="wr-menu-btn" onClick={closeAnd(onRowBelow)}>
              <ArrowDown aria-hidden="true" className="wr-icon" /> Insert below
            </button>
            <button type="button" className="wr-menu-btn wr-menu-btn--danger" onClick={closeAnd(onDeleteRow)}>
              <Trash2 aria-hidden="true" className="wr-icon" /> Delete row
            </button>
          </div>
          <div className="wr-table-menu__section">Columns</div>
          <div className="wr-table-menu__row">
            <button type="button" className="wr-menu-btn" onClick={closeAnd(onColLeft)}>
              <ArrowLeft aria-hidden="true" className="wr-icon" /> Insert left
            </button>
            <button type="button" className="wr-menu-btn" onClick={closeAnd(onColRight)}>
              <ArrowRight aria-hidden="true" className="wr-icon" /> Insert right
            </button>
            <button type="button" className="wr-menu-btn wr-menu-btn--danger" onClick={closeAnd(onDeleteCol)}>
              <Trash2 aria-hidden="true" className="wr-icon" /> Delete column
            </button>
          </div>
          <div className="wr-table-menu__section">Cells</div>
          <div className="wr-table-menu__row">
            <button type="button" className="wr-menu-btn" disabled={!canMerge} onClick={closeAnd(onMerge)}>
              <Merge aria-hidden="true" className="wr-icon" /> Merge
            </button>
            <button type="button" className="wr-menu-btn" disabled={!canSplit} onClick={closeAnd(onSplit)}>
              <SplitSquareHorizontal aria-hidden="true" className="wr-icon" /> Split
            </button>
          </div>
          <div className="wr-table-menu__section">Cell fill</div>
          <button type="button" className="wr-popover__auto" onClick={() => { onCellFill(null); setOpen(false); }}>
            No fill
          </button>
          <div className="wr-swatch-grid">
            {COLOR_SWATCHES.map((hex) => (
              <button
                key={hex} type="button" title={hex} aria-label={hex} className="wr-swatch"
                style={{ backgroundColor: hex }} onClick={() => { onCellFill(hex); setOpen(false); }}
              />
            ))}
          </div>
          <div className="wr-table-menu__section">Table</div>
          <button type="button" className="wr-menu-btn wr-menu-btn--danger wr-menu-btn--block" onClick={closeAnd(onDeleteTable)}>
            <Trash2 aria-hidden="true" className="wr-icon" /> Delete table
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}

function InsertLinkMenu({ disabled, onInsert }: { disabled: boolean; onInsert: (url: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const submit = () => {
    const trimmed = url.trim();
    if (trimmed === "") return;
    onInsert(trimmed);
    setOpen(false);
    setUrl("");
  };
  return (
    <>
      <button
        ref={btnRef} type="button" title="Insert link" aria-label="Insert link" aria-haspopup="true"
        aria-expanded={open} disabled={disabled} className={`wr-btn${open ? " wr-btn--active" : ""}`}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}
      >
        <LinkIcon aria-hidden="true" className="wr-icon" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="wr-link">
          <input
            type="url" placeholder="https://…" value={url} autoFocus
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            className="wr-text"
          />
          <button type="button" disabled={url.trim() === ""} className="wr-primary" onClick={submit}>Insert link</button>
        </div>
      </AnchoredPopover>
    </>
  );
}

type FindReplaceMode = "find" | "replace";

/**
 * Find & Replace popover. Drives the engine's `FindReplaceState` (which walks the
 * `Doc` model and mutates via `insertText`/`deleteText`) and mirrors match state
 * into the canvas via `setSearchMatches` / `clearSearchMatches` so highlights and
 * active-match scrolling are painted by the engine. The engine fires
 * `onFindRequest` (Cmd/Ctrl+F) and `onFindReplaceRequest` (Cmd/Ctrl+H) — the
 * parent registers those to open this menu in the matching mode.
 */
function FindReplaceMenu({
  editor, disabled, open, mode, onOpen, onClose,
}: {
  editor: EditorAPI | null;
  disabled: boolean;
  open: boolean;
  mode: FindReplaceMode;
  onOpen: (mode: FindReplaceMode) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [count, setCount] = useState<{ total: number; active: number }>({ total: 0, active: -1 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const frRef = useRef<FindReplaceState | null>(null);
  // Latest query/options kept in refs so the engine-callback keybind path can
  // re-run a search without re-rendering the whole menu.
  const queryRef = useRef("");
  const optsRef = useRef({ caseSensitive, useRegex });
  useEffect(() => { queryRef.current = query; }, [query]);
  useEffect(() => { optsRef.current = { caseSensitive, useRegex }; }, [caseSensitive, useRegex]);

  const ensureState = useCallback((): FindReplaceState | null => {
    if (!editor) return null;
    if (!frRef.current) {
      frRef.current = new FindReplaceState(editor.getDoc(), () => editor.getStore().snapshot());
    }
    return frRef.current;
  }, [editor]);

  const syncMatches = useCallback(
    (fr: FindReplaceState) => {
      editor?.setSearchMatches(fr.matches, fr.activeIndex);
      setCount({ total: fr.matches.length, active: fr.activeIndex });
    },
    [editor],
  );

  const runSearch = useCallback(() => {
    const fr = ensureState();
    if (!fr) return;
    const q = queryRef.current;
    fr.search(q, optsRef.current);
    syncMatches(fr);
  }, [ensureState, syncMatches]);

  const step = useCallback(
    (dir: "next" | "prev") => {
      const fr = ensureState();
      if (!fr || fr.matches.length === 0) return;
      if (dir === "next") fr.next();
      else fr.previous();
      syncMatches(fr);
    },
    [ensureState, syncMatches],
  );

  const replaceOne = useCallback(() => {
    const fr = ensureState();
    if (!fr || fr.activeIndex < 0) return;
    fr.replaceActive(replacement);
    syncMatches(fr);
  }, [ensureState, replacement, syncMatches]);

  const replaceAll = useCallback(() => {
    const fr = ensureState();
    if (!fr || fr.matches.length === 0) return;
    fr.replaceAll(replacement);
    syncMatches(fr);
  }, [ensureState, replacement, syncMatches]);

  // Re-run search when query/options change while open.
  useEffect(() => {
    if (!open) return;
    runSearch();
  }, [open, query, caseSensitive, useRegex, runSearch]);

  // Focus the right input when the menu opens / mode flips.
  useEffect(() => {
    if (!open) return;
    setShowReplace(mode === "replace");
    const t = window.setTimeout(() => {
      if (mode === "replace" && replaceInputRef.current) replaceInputRef.current.focus();
      else findInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, mode]);

  // Clear engine highlights when the menu closes (and drop our FindReplaceState
  // so the next open re-searches against a fresh doc).
  const handleClose = useCallback(() => {
    editor?.clearSearchMatches();
    frRef.current = null;
    setCount({ total: 0, active: -1 });
    onClose();
  }, [editor, onClose]);

  const countLabel =
    count.total > 0
      ? `${count.active + 1} / ${count.total}`
      : query.trim() === ""
        ? ""
        : "No matches";

  return (
    <>
      <button
        ref={btnRef} type="button" title="Find & replace" aria-label="Find & replace" aria-haspopup="true"
        aria-expanded={open} disabled={disabled}
        className={`wr-btn${open ? " wr-btn--active" : ""}`}
        onMouseDown={(e) => e.preventDefault()} onClick={() => onOpen(open ? "find" : "find")}
      >
        <Search aria-hidden="true" className="wr-icon" />
      </button>
      <AnchoredPopover open={open} onClose={handleClose} anchorRef={btnRef} align="right">
        <div className="wr-find">
          <div className="wr-find__top">
            <button
              type="button" title={showReplace ? "Hide replace" : "Show replace"} aria-label="Toggle replace"
              className="wr-find__toggle" onClick={() => setShowReplace((v) => !v)}
            >
              {showReplace ? "▾" : "▸"}
            </button>
            <input
              ref={findInputRef} type="text" placeholder="Find in document" value={query}
              className="wr-find__input"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) step("prev");
                  else step("next");
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  handleClose();
                }
              }}
            />
            <button
              type="button" title="Case sensitive" aria-label="Case sensitive" aria-pressed={caseSensitive}
              className={`wr-find__opt${caseSensitive ? " wr-find__opt--active" : ""}`}
              onClick={() => setCaseSensitive((v) => !v)}
            >
              <CaseSensitive aria-hidden="true" className="wr-icon" />
            </button>
            <button
              type="button" title="Regular expression" aria-label="Regular expression" aria-pressed={useRegex}
              className={`wr-find__opt${useRegex ? " wr-find__opt--active" : ""}`}
              onClick={() => setUseRegex((v) => !v)}
            >
              <RegexIcon aria-hidden="true" className="wr-icon" />
            </button>
            <button
              type="button" title="Find previous" aria-label="Find previous" disabled={count.total === 0}
              className="wr-find__nav" onClick={() => step("prev")}
            >
              <ChevronLeft aria-hidden="true" className="wr-icon" />
            </button>
            <button
              type="button" title="Find next" aria-label="Find next" disabled={count.total === 0}
              className="wr-find__nav" onClick={() => step("next")}
            >
              <ChevronRight aria-hidden="true" className="wr-icon" />
            </button>
            <span className="wr-find__count" aria-live="polite">{countLabel}</span>
          </div>
          {showReplace && (
            <div className="wr-find__replace">
              <Replace aria-hidden="true" className="wr-find__replace-icon" />
              <input
                ref={replaceInputRef} type="text" placeholder="Replace with" value={replacement}
                className="wr-find__input"
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); replaceOne(); }
                  else if (e.key === "Escape") { e.preventDefault(); handleClose(); }
                }}
              />
              <button
                type="button" title="Replace" disabled={count.total === 0}
                className="wr-secondary" onClick={replaceOne}
              >
                Replace
              </button>
              <button
                type="button" title="Replace all" disabled={count.total === 0}
                className="wr-secondary" onClick={replaceAll}
              >
                All
              </button>
            </div>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

export interface WriterDocSurfaceProps {
  editor: EditorAPI | null;
  /** Parent mounts the Wafflebase editor into this element. */
  canvasRef: (el: HTMLDivElement | null) => void;
  saveStatus: WriterSaveStatus;
  banner?: ReactNode;
  suggestionState?: SuggestionState;
  activeSuggestionChangeId?: string | null;
  onActiveSuggestionChange?: (changeId: string | null) => void;
  onAcceptSuggestion?: (all: boolean, changeId?: string) => void;
  onRejectSuggestion?: (all: boolean, changeId?: string) => void;
  onNoEffectiveSuggestion?: () => void;
  onContinueEditing?: () => void;
  onDismissSuggestion?: () => void;
  spellPreference?: { enabled: boolean; language: "en-US"; personalWords: string[] } | null;
  onSpellPreferenceChange?: (next: { enabled: boolean; language: "en-US"; personalWords: string[] }) => void;
}

/**
 * A detached, read-only Wafflebase editor for proposal review. Its MemDocStore
 * is built solely from the projection, so the canonical store/editor cannot be
 * changed by rendering or interacting with this surface.
 */
function ReviewProjectionSurface({
  suggestion, activeChangeId, activePosition, activeCount, theme,
}: {
  suggestion: PendingSuggestionState;
  activeChangeId: string | null;
  activePosition: number;
  activeCount: number;
  theme: ThemeMode;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const reviewEditorRef = useRef<EditorAPI | null>(null);
  const selectedChanges = useMemo(() => selectedSuggestionChanges(suggestion), [suggestion]);
  const projection = useMemo(
    () => {
      const hasRemainingChanges = selectedChanges.length > 0;
      return buildReviewProjection(
        suggestion.reviewBaseDoc,
        hasRemainingChanges ? suggestion.proposedDoc : suggestion.reviewBaseDoc,
        selectedChanges,
        suggestion.operationMetadata,
      );
    },
    [suggestion.reviewBaseDoc, suggestion.proposedDoc, selectedChanges, suggestion.operationMetadata],
  );
  const activeRanges = useMemo(
    () => resolveReviewFocusRanges(projection.document, projection.items, activeChangeId),
    [activeChangeId, projection],
  );
  const activeAnchor = activeRanges[0]
    ? { blockId: activeRanges[0].blockId, offset: activeRanges[0].startOffset }
    : null;
  // The projection is immutable. A new object therefore marks a remount
  // generation; an RAF from the prior editor must not move the new surface.
  const projectionRef = useRef(projection);
  const projectionGenerationRef = useRef(0);
  if (projectionRef.current !== projection) {
    projectionRef.current = projection;
    projectionGenerationRef.current += 1;
  }
  const projectionGeneration = projectionGenerationRef.current;
  const activeTargetRef = useRef({
    generation: projectionGeneration,
    changeId: activeChangeId,
    anchor: activeAnchor,
  });
  activeTargetRef.current = {
    generation: projectionGeneration,
    changeId: activeChangeId,
    anchor: activeAnchor,
  };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reviewEditor = initialize(host, new MemDocStore(projection.document), theme, true);
    reviewEditorRef.current = reviewEditor;
    return () => {
      reviewEditorRef.current = null;
      reviewEditor.clearSearchMatches();
      reviewEditor.dispose();
      // `dispose()` removes the canvas; the spacer is a mount artifact too.
      host.replaceChildren();
    };
  }, [projection, theme]);

  useEffect(() => {
    if (!activeAnchor || activeRanges.length === 0) {
      reviewEditorRef.current?.clearSearchMatches();
      return;
    }
    const scheduler = scheduleReviewFocus(
      { generation: projectionGeneration, changeId: activeChangeId },
      () => ({
        generation: activeTargetRef.current.generation,
        changeId: activeTargetRef.current.changeId,
      }),
      () => {
        const reviewEditor = reviewEditorRef.current;
        if (!reviewEditor) return;
        // Search matches provide the engine's strongest active redline
        // treatment and own its native scroll. Position scrolling is a
        // post-highlight fallback for paint cycles with late metrics.
        reviewEditor.setSearchMatches(activeRanges, 0);
        reviewEditor.scrollToPosition(activeAnchor);
      },
    );
    return () => scheduler.cancel();
  }, [activeAnchor, activeChangeId, activeRanges, projectionGeneration]);

  useEffect(() => () => reviewEditorRef.current?.clearSearchMatches(), []);

  return (
    <div
      ref={hostRef}
      role="region"
      className="writer-canvas__projection"
      data-review-active={activeChangeId ? "true" : "false"}
      aria-label={activeChangeId
        ? `Reviewing suggested change ${activePosition} of ${activeCount}, read-only`
        : "Accepted review changes, ready to save, read-only"}
    />
  );
}

/** Small save indicator that flashes when a save lands, then settles muted. */
function SaveChip({ status }: { status: WriterSaveStatus }): JSX.Element | null {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status === "saved") setTick((t) => t + 1);
  }, [status]);
  const label = statusLabel(status);
  if (!label) return null;
  return (
    <span
      key={status === "saved" ? `saved-${tick}` : status}
      className={`wr-save-chip wr-save-chip--${status}${status === "saved" ? " wr-flash" : ""}`}
      aria-live="polite"
    >
      {label}
    </span>
  );
}

function SuggestionReviewControls({
  state, activeChangeId, onActiveChange, onAccept, onReject, onNoEffectiveSuggestion, onContinueEditing, onDismiss,
}: {
  state: SuggestionState;
  activeChangeId?: string | null;
  onActiveChange?: (changeId: string | null) => void;
  onAccept?: (all: boolean, changeId?: string) => void;
  onReject?: (all: boolean, changeId?: string) => void;
  onNoEffectiveSuggestion?: () => void;
  onContinueEditing?: () => void;
  onDismiss?: () => void;
}): JSX.Element | null {
  const pending = state.kind === "pending" ? state : null;
  const presentation = pending
    ? reviewSurfaceState(selectedSuggestionChanges(pending), pending.acceptedOperationIndexes, activeChangeId)
    : null;
  const selectedChanges = presentation?.changes ?? [];
  const activeIndex = presentation?.activeChangeId
    ? selectedChanges.findIndex((change) => change.id === presentation.activeChangeId)
    : -1;
  const activeChange = activeIndex >= 0 ? selectedChanges[activeIndex] : null;
  const activePosition = activeIndex + 1;

  useEffect(() => {
    if (!pending) return;
    onActiveChange?.(selectedSuggestionChanges(pending)[0]?.id ?? null);
  }, [pending?.proposalId, onActiveChange]);

  useEffect(() => {
    if (!pending || (activeChangeId && selectedChanges.some((change) => change.id === activeChangeId))) return;
    onActiveChange?.(selectedChanges[0]?.id ?? null);
  }, [activeChangeId, onActiveChange, pending, selectedChanges]);

  if (state.kind === "idle") return null;
  if (state.kind === "accepting" || state.kind === "rejecting" || state.kind === "validating") {
    const label = state.kind === "accepting"
      ? "Accepting suggestion…"
      : state.kind === "rejecting"
        ? "Rejecting suggestion…"
        : "Validating suggestion…";
    return (
      <div className="wr-suggestion-review" role="status" aria-live="polite">
        <span className="wr-suggestion-review__label">Review changes</span>
        <span className="wr-suggestion-review__status">{label}</span>
        {onContinueEditing ? (
          <button
            type="button"
            className="wr-suggestion-review__button wr-suggestion-review__button--neutral"
            onClick={onContinueEditing}
          >
            Continue editing
          </button>
        ) : null}
      </div>
    );
  }
  if (state.kind !== "pending") {
    const label = state.kind === "completed"
      ? `Suggestion ${state.outcome}.`
      : state.kind === "invalidated"
        ? `Suggestion invalidated: ${state.reason.replaceAll("_", " ")}.`
        : `Suggestion failed: ${state.message}`;
    return (
      <div className="wr-suggestion-review" role="status" aria-live="polite">
        <span className="wr-suggestion-review__label">Review changes</span>
        <span className="wr-suggestion-review__status">{label}</span>
        <button type="button" className="wr-suggestion-review__button wr-suggestion-review__button--neutral" onClick={onDismiss}>Dismiss</button>
      </div>
    );
  }

  if (pending && presentation?.isFinalAcceptedState && pending.persistenceError) {
    return (
      <section className="wr-suggestion-review" aria-label="Retry accepted review changes">
        <div className="wr-suggestion-review__actions">
          <span className="wr-suggestion-review__label">Review changes</span>
          <button
            type="button"
            className="wr-suggestion-review__button wr-suggestion-review__button--accept"
            disabled={!presentation.canSaveAcceptedChanges}
            onClick={() => onAccept?.(true)}
          >
            Retry save accepted changes
          </button>
          {onContinueEditing ? (
            <button
              type="button"
              className="wr-suggestion-review__button wr-suggestion-review__button--neutral"
              onClick={onContinueEditing}
            >
              Continue editing
            </button>
          ) : null}
        </div>
        <span className="wr-suggestion-review__status" aria-live="polite">
          {pending.persistenceError} Retry to save the accepted batch.
        </span>
      </section>
    );
  }

  if (pending && selectedChanges.length === 0) {
    return (
      <section className="wr-suggestion-review" aria-label="No document changes needed">
        <div className="wr-suggestion-review__actions">
          <span className="wr-suggestion-review__label">Review changes</span>
          <button
            type="button"
            className="wr-suggestion-review__button wr-suggestion-review__button--neutral"
            onClick={onNoEffectiveSuggestion}
          >
            Close review
          </button>
        </div>
        <span className="wr-suggestion-review__status" aria-live="polite">
          No document changes were needed. Close this review to let the task finish truthfully.
        </span>
      </section>
    );
  }

  if (presentation?.isFinalAcceptedState) return null;

  const navigate = (direction: 1 | -1) => {
    if (selectedChanges.length === 0) return;
    const current = activeIndex >= 0 ? activeIndex : direction === 1 ? -1 : 0;
    onActiveChange?.(selectedChanges[(current + direction + selectedChanges.length) % selectedChanges.length]?.id ?? null);
  };

  const rejectActive = () => {
    if (!activeChange) return;
    onReject?.(false, activeChange.id);
  };

  const acceptActive = () => {
    if (!activeChange) return;
    onAccept?.(false, activeChange.id);
  };

  return (
    <section className="wr-suggestion-review" aria-label="Review suggested changes">
      <div className="wr-suggestion-review__actions">
        <span className="wr-suggestion-review__label">Review changes</span>
        <button type="button" className="wr-suggestion-review__button wr-suggestion-review__button--reject" disabled={selectedChanges.length === 0} onClick={() => onReject?.(true)}>Reject all</button>
        <button type="button" className="wr-suggestion-review__button wr-suggestion-review__button--accept" disabled={selectedChanges.length === 0} onClick={() => onAccept?.(true)}>Accept all</button>
        <span className="wr-suggestion-review__navigation" role="group" aria-label="Change navigation">
          <button type="button" className="wr-suggestion-review__button wr-suggestion-review__button--neutral" disabled={selectedChanges.length < 2} onClick={() => navigate(-1)}>Previous</button>
        <span className="wr-suggestion-review__count" aria-live="polite">
          {activeChange ? `${activePosition} / ${selectedChanges.length}` : "0 / 0"}
        </span>
          <button type="button" className="wr-suggestion-review__button wr-suggestion-review__button--neutral" disabled={selectedChanges.length < 2} onClick={() => navigate(1)}>Next</button>
        </span>
        <button type="button" className="wr-suggestion-review__button wr-suggestion-review__button--reject" disabled={!activeChange} onClick={rejectActive}>Reject</button>
        <button type="button" className="wr-suggestion-review__button wr-suggestion-review__button--accept" disabled={!activeChange} onClick={acceptActive}>Accept</button>
        {onContinueEditing ? (
          <button
            type="button"
            className="wr-suggestion-review__button wr-suggestion-review__button--neutral"
            onClick={onContinueEditing}
          >
            Continue editing
          </button>
        ) : null}
      </div>
      <span className="wr-suggestion-review__status" aria-live="polite">
        {activeChange
          ? `Reviewing change ${activePosition} of ${selectedChanges.length}. Accepting updates this review only; the final acceptance saves the batch.`
          : "Saving accepted changes…"}
      </span>
    </section>
  );
}

export function WriterDocSurface({
  editor, canvasRef, saveStatus, banner, suggestionState = { kind: "idle" },
  activeSuggestionChangeId, onActiveSuggestionChange, onAcceptSuggestion,
  onRejectSuggestion, onNoEffectiveSuggestion, onContinueEditing, onDismissSuggestion, spellPreference, onSpellPreferenceChange,
}: WriterDocSurfaceProps): JSX.Element {
  const [ts, setTs] = useState<ToolbarState>(EMPTY_STATE);
  const [tableTs, setTableTs] = useState<TableToolbarState>(EMPTY_TABLE_STATE);
  const [theme, setThemeState] = useState<ThemeMode>("light");
  const [findOpen, setFindOpen] = useState(false);
  const [findMode, setFindMode] = useState<FindReplaceMode>("find");
  const [spellMenu, setSpellMenu] = useState<WriterSpellMenuRequest | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const reviewingSuggestion = suggestionState.kind === "pending";
  const reviewPresentation = suggestionState.kind === "pending"
    ? reviewSurfaceState(
      selectedSuggestionChanges(suggestionState),
      suggestionState.acceptedOperationIndexes,
      activeSuggestionChangeId,
    )
    : null;
  const reviewChanges = reviewPresentation?.changes ?? [];
  const reviewActiveChangeId = reviewPresentation?.activeChangeId ?? null;
  const ready = editor !== null && !reviewingSuggestion;

  const refreshToolbar = useCallback(() => {
    if (!editor) return;
    setTs(readToolbarState(editor));
    setTableTs(readTableState(editor));
  }, [editor]);

  // §3.3.6 — reflect live selection/cursor state onto the toolbar. onCursorMove
  // also fires after style mutations, so this covers post-command refresh too.
  useEffect(() => {
    if (!editor) return;
    refreshToolbar();
    const unsub = editor.onCursorMove(() => refreshToolbar());
    return () => unsub();
  }, [editor, refreshToolbar]);

  // Engine → menu: Cmd/Ctrl+F opens Find, Cmd/Ctrl+H opens Replace. The engine
  // owns the keybind and fires these callbacks; we just translate to UI state.
  useEffect(() => {
    if (!editor) return;
    editor.onFindRequest(() => { setFindMode("find"); setFindOpen(true); });
    editor.onFindReplaceRequest(() => { setFindMode("replace"); setFindOpen(true); });
  }, [editor]);

  // View-local spellcheck: session attach, debounced rechecks, context-menu hook.
  useEffect(() => {
    const canvasEl = canvasHostRef.current;
    if (!editor || !canvasEl || !spellPreference) return;
    return attachWriterSpellcheck(editor, canvasEl, setSpellMenu, spellPreference);
  }, [editor, spellPreference?.language]);
  useEffect(() => {
    if (!editor || !spellPreference) return;
    setWriterSpellcheckPersonalWords(editor, spellPreference.personalWords);
    setWriterSpellcheckEnabled(editor, spellPreference.enabled);
    if (!spellPreference.enabled) setSpellMenu(null);
  }, [editor, spellPreference]);
  const setSpellEnabled = useCallback((enabled: boolean) => {
    if (!spellPreference) return;
    setSpellMenu(null); if (editor) setWriterSpellcheckEnabled(editor, enabled);
    onSpellPreferenceChange?.({ ...spellPreference, enabled });
  }, [editor, onSpellPreferenceChange, spellPreference]);
  const ignoreSpellWord = useCallback((word: string) => { if (editor) ignoreWriterSpellWord(editor, word); }, [editor]);
  const learnSpellWord = useCallback((word: string) => {
    if (!spellPreference) return;
    const normalized = word.normalize("NFC").trim().toLocaleLowerCase();
    if (!normalized || spellPreference.personalWords.includes(normalized)) return;
    onSpellPreferenceChange?.({ ...spellPreference, personalWords: [...spellPreference.personalWords, normalized].slice(0, 256) });
  }, [onSpellPreferenceChange, spellPreference]);

  const openFind = useCallback((mode: FindReplaceMode) => {
    setFindMode(mode);
    setFindOpen((v) => !v);
  }, []);

  const closeFind = useCallback(() => setFindOpen(false), []);

  const run = useCallback((fn: (e: EditorAPI) => void) => {
    if (!editor) return;
    fn(editor);
    refreshToolbar();
    editor.focus();
  }, [editor, refreshToolbar]);

  const toggleTheme = useCallback(() => {
    if (!editor) return;
    const next: ThemeMode = theme === "light" ? "dark" : "light";
    // Module-level theme drives canvas-painted chrome (incl. the ruler gutter);
    // the instance setTheme themes the doc. Set both, then repaint.
    setThemeMode(next);
    editor.setTheme(next);
    editor.render();
    setThemeState(next);
    editor.focus();
  }, [editor, theme]);

  return (
    <PopoverThemeContext.Provider value={theme}>
    <div className="writer-app" data-theme={theme}>
      <div className="wr-toolbar" role="toolbar" aria-label="Formatting">
        <div className="wr-band" role="group" aria-label="Text formatting">
          <RibbonGroup label="History">
            <ToolButton title="Undo" Icon={Undo2} disabled={!ready} onClick={() => run((e) => e.undo())} />
            <ToolButton title="Redo" Icon={Redo2} disabled={!ready} onClick={() => run((e) => e.redo())} />
          </RibbonGroup>

          <RibbonGroup label="Style">
            <select
              aria-label="Paragraph style" title="Paragraph style" disabled={!ready}
              className="wr-select wr-select--style" value={ts.paraValue}
              onChange={(e) => run((ed) => {
                const v = e.target.value;
                if (v === "") ed.setBlockType("paragraph" as BlockType);
                else if (v === "title" || v === "subtitle") ed.setBlockType(v as BlockType);
                else ed.setBlockType("heading" as BlockType, { headingLevel: Number(v.slice(1)) as 1 | 2 | 3 });
              })}
            >
              {PARAGRAPH_STYLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </RibbonGroup>

          <RibbonGroup label="Font">
            <select
              aria-label="Font" title="Font" disabled={!ready} className="wr-select wr-select--font"
              value={ts.fontFamily}
              onChange={(e) => run((ed) => ed.applyStyle({ fontFamily: e.target.value }))}
            >
              <option value="">Font</option>
              {(ts.fontFamily && !FONT_FAMILIES.includes(ts.fontFamily) ? [ts.fontFamily, ...FONT_FAMILIES] : FONT_FAMILIES)
                .map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <FontSizeControl
              disabled={!ready}
              value={ts.fontSize}
              onCommit={(n) => run((ed) => ed.applyStyle({ fontSize: n }))}
            />
            <ToolButton title="Bold" Icon={Bold} active={ts.bold} disabled={!ready} onClick={() => run((e) => e.applyStyle({ bold: !ts.bold }))} />
            <ToolButton title="Italic" Icon={Italic} active={ts.italic} disabled={!ready} onClick={() => run((e) => e.applyStyle({ italic: !ts.italic }))} />
            <ToolButton title="Underline" Icon={Underline} active={ts.underline} disabled={!ready} onClick={() => run((e) => e.applyStyle({ underline: !ts.underline }))} />
            <ToolButton title="Strikethrough" Icon={Strikethrough} active={ts.strikethrough} disabled={!ready} onClick={() => run((e) => e.applyStyle({ strikethrough: !ts.strikethrough }))} />
            <ToolButton title="Subscript" Icon={Subscript} active={ts.subscript} disabled={!ready} onClick={() => run((e) => e.applyStyle({ subscript: !ts.subscript }))} />
            <ToolButton title="Superscript" Icon={Superscript} active={ts.superscript} disabled={!ready} onClick={() => run((e) => e.applyStyle({ superscript: !ts.superscript }))} />
            <ToolButton title="Clear formatting" Icon={RemoveFormatting} disabled={!ready} onClick={() => run((e) => e.clearInlineFormatting())} />
            <ColorSwatchMenu
              title="Text color" Icon={Baseline} autoLabel="Automatic" disabled={!ready} currentColor={ts.color}
              onPick={(hex) => run((e) => e.applyStyle({ color: hex ?? undefined }))}
            />
            <ColorSwatchMenu
              title="Highlight color" Icon={Highlighter} autoLabel="No fill" disabled={!ready} currentColor={ts.backgroundColor}
              onPick={(hex) => run((e) => e.applyStyle({ backgroundColor: hex ?? undefined }))}
            />
          </RibbonGroup>
          <div className="wr-spacer" />
          <SaveChip status={saveStatus} />
        </div>

        <div className="wr-band" role="group" aria-label="Paragraph and insert">
          <RibbonGroup label="Paragraph">
            <ToolButton title="Bulleted list" Icon={List} active={ts.listKind === "unordered"} disabled={!ready} onClick={() => run((e) => e.toggleList("unordered"))} />
            <ToolButton title="Numbered list" Icon={ListOrdered} active={ts.listKind === "ordered"} disabled={!ready} onClick={() => run((e) => e.toggleList("ordered"))} />
            <ToolButton title="Align left" Icon={AlignLeft} active={ts.alignment === "left"} disabled={!ready} onClick={() => run((e) => e.applyBlockStyle({ alignment: "left" }))} />
            <ToolButton title="Align center" Icon={AlignCenter} active={ts.alignment === "center"} disabled={!ready} onClick={() => run((e) => e.applyBlockStyle({ alignment: "center" }))} />
            <ToolButton title="Align right" Icon={AlignRight} active={ts.alignment === "right"} disabled={!ready} onClick={() => run((e) => e.applyBlockStyle({ alignment: "right" }))} />
            <ToolButton title="Justify" Icon={AlignJustify} active={ts.alignment === "justify"} disabled={!ready} onClick={() => run((e) => e.applyBlockStyle({ alignment: "justify" }))} />
            <ToolButton title="Decrease indent" Icon={IndentDecrease} disabled={!ready} onClick={() => run((e) => e.outdent())} />
            <ToolButton title="Increase indent" Icon={IndentIncrease} disabled={!ready} onClick={() => run((e) => e.indent())} />
          </RibbonGroup>

          <RibbonGroup label="Insert">
            <InsertTableMenu disabled={!ready} onInsert={(rows, cols) => run((e) => e.insertTable(rows, cols))} />
            <ImageInsertButton disabled={!ready} onPick={(src, w, h, alt) => run((e) => e.insertImage(src, w, h, alt ? { alt } : undefined))} />
            <InsertLinkMenu disabled={!ready} onInsert={(url) => run((e) => e.insertLink(url))} />
          </RibbonGroup>

          {tableTs.inTable && (
            <RibbonGroup label="Table">
              <TableToolsMenu
                disabled={!ready}
                mergeContext={tableTs.mergeContext}
                onRowAbove={() => run((e) => e.insertTableRow(true))}
                onRowBelow={() => run((e) => e.insertTableRow(false))}
                onDeleteRow={() => run((e) => e.deleteTableRow())}
                onColLeft={() => run((e) => e.insertTableColumn(true))}
                onColRight={() => run((e) => e.insertTableColumn(false))}
                onDeleteCol={() => run((e) => e.deleteTableColumn())}
                onMerge={() => run((e) => {
                  const ctx = e.getTableMergeContext();
                  if (ctx.state === "canMerge") e.mergeTableCells(ctx.range);
                })}
                onSplit={() => run((e) => e.splitTableCell())}
                onCellFill={(hex) => run((e) => e.applyTableCellStyle({ backgroundColor: hex ?? undefined }))}
                onDeleteTable={() => run((e) => e.deleteTable())}
              />
            </RibbonGroup>
          )}

          <RibbonGroup label="View">
            <label className="wr-spell-toggle"><input type="checkbox" checked={spellPreference?.enabled ?? false} disabled={!ready || !spellPreference} onChange={(event) => setSpellEnabled(event.target.checked)} /><span>Check spelling</span></label>
            <FindReplaceMenu
              editor={editor}
              disabled={!ready}
              open={findOpen}
              mode={findMode}
              onOpen={openFind}
              onClose={closeFind}
            />
            <ToolButton
              title={theme === "light" ? "Dark mode" : "Light mode"}
              Icon={theme === "light" ? Moon : Sun}
              disabled={!ready}
              onClick={toggleTheme}
            />
          </RibbonGroup>
        </div>
      </div>

      {banner}
      <SuggestionReviewControls
        state={suggestionState}
        activeChangeId={reviewActiveChangeId}
        onActiveChange={onActiveSuggestionChange}
        onAccept={onAcceptSuggestion}
      onReject={onRejectSuggestion}
      onNoEffectiveSuggestion={onNoEffectiveSuggestion}
        onContinueEditing={onContinueEditing}
        onDismiss={onDismissSuggestion}
      />

      <div className={`writer-canvas${reviewingSuggestion ? " writer-canvas--review" : ""}`}>
        <div
          ref={(el) => {
            canvasHostRef.current = el;
            canvasRef(el);
          }}
          className={`writer-canvas__editor${reviewingSuggestion ? " writer-canvas__editor--hidden" : ""}`}
        />
        {suggestionState.kind === "pending" && reviewPresentation?.shouldRenderProjection && (
          <ReviewProjectionSurface
            suggestion={suggestionState}
            activeChangeId={reviewActiveChangeId}
            activePosition={reviewChanges.findIndex((change) => change.id === reviewActiveChangeId) + 1}
            activeCount={reviewChanges.length}
            theme={theme}
          />
        )}
      </div>
      <WriterSpellMenu
        editor={editor}
        request={spellMenu}
        theme={theme}
        onIgnore={ignoreSpellWord}
        onLearn={learnSpellWord}
        onClose={() => setSpellMenu(null)}
      />
    </div>
    </PopoverThemeContext.Provider>
  );
}

/** Insert image via a file picker → data URL (offline / E2EE-safe, no upload). */
function ImageInsertButton({
  disabled, onPick,
}: {
  disabled: boolean;
  onPick: (src: string, width: number, height: number, alt?: string) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const onFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === "string" ? reader.result : "";
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        const maxW = 600;
        const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
        onPick(src, Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale), file.name);
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }, [onPick]);
  return (
    <>
      <button
        type="button" title="Insert image" aria-label="Insert image" disabled={disabled}
        className="wr-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => inputRef.current?.click()}
      >
        <ImageIcon aria-hidden="true" className="wr-icon" />
      </button>
      <input
        ref={inputRef} type="file" accept="image/*" hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}
