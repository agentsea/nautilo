import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createWorkbenchPortal as createPortal } from "../components/workbench-portals";
import {
  ChevronDown,
  ChevronUp,
  Link as LinkIcon,
  Search,
  Table as TableIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type CoolMessage = { MessageId?: string; Values?: Record<string, unknown> };

export function toolbarButtonClass(active = false): string {
  const base =
    "rounded p-1.5 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";
  // §3.3.6 — an active/toggled command lights the button in the primary token.
  return active ? `${base} bg-primary-muted text-primary` : `${base} text-foreground-muted`;
}

/** §3.3.5-B — shared styling for the style/font/size dropdowns. */
export function toolbarSelectClass(): string {
  return "h-6 shrink-0 rounded border border-border bg-background-element px-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-border-interactive disabled:cursor-not-allowed disabled:opacity-40";
}

/**
 * §3.3.5 — a ribbon group: a row of controls with a small caption beneath.
 * Label-free grouping + spacing + captions gives the "ordered ribbon" look
 * without tabs (which would hide controls behind a tab switch).
 */
export function RibbonGroup({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1 rounded-md bg-background-element/40 px-2 py-1">
      <span className="select-none text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground-muted/80">{label}</span>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

/**
 * §3.3.5-B — paragraph-style dropdown: user-facing label ↔ LibreOffice
 * style name sent via `.uno:StyleApply`. "Normal" maps to LO's
 * "Default Paragraph Style" (what the state channel reports).
 */
export const PARAGRAPH_STYLES: ReadonlyArray<{ label: string; style: string }> = [
  { label: "Normal", style: "Default Paragraph Style" },
  { label: "Title", style: "Title" },
  { label: "Subtitle", style: "Subtitle" },
  { label: "Heading 1", style: "Heading 1" },
  { label: "Heading 2", style: "Heading 2" },
  { label: "Heading 3", style: "Heading 3" },
];

/** Common families (incl. the metric-compatible Carlito/Caladea we install in the engine). */
export const FONT_FAMILIES: readonly string[] = [
  "Calibri", "Carlito", "Cambria", "Caladea", "Arial", "Liberation Sans",
  "Times New Roman", "Liberation Serif", "Courier New", "Liberation Mono",
  "Georgia", "Verdana", "Noto Sans", "DejaVu Sans",
];

export const FONT_SIZES: readonly string[] = [
  "8", "9", "10", "10.5", "11", "12", "14", "16", "18", "20", "24", "28", "32", "36", "48", "72",
];

/** Coerce a tracked-state value to a display string (primitives only). */
export function stateStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/**
 * §3.3.5-C — swatch palette for the text-color / highlight pickers
 * (Google-Docs-ish: greys row, bright row, muted row). Values are hex; we
 * send the `0xRRGGBB` integer LibreOffice expects.
 */
const COLOR_SWATCHES: readonly string[] = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#efefef", "#ffffff",
  "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#9900ff", "#ff00ff",
  "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6", "#674ea7", "#a64d79",
];

/** State value (an integer color as string) → `#rrggbb`, or null for auto/none/invalid. */
export function intColorToHex(v: unknown): string | null {
  const s = stateStr(v);
  if (s === "") return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Wave C — the action surface an app-specific ribbon group needs, injected by
 * the host surface so Calc/Impress group components stay pure and reusable.
 * `isActive`/`stateValue` read the §3.3.6 command-state channel (bare command
 * name, no `.uno:`).
 */
export interface RibbonActions {
  ready: boolean;
  sendUno: (command: string) => void;
  // `value` is `unknown` (not just primitives) because some UNO commands take
  // nested struct args — e.g. Calc `.uno:SetBorderStyle` passes
  // `[]com.sun.star.table.BorderLine2` for `OuterBorder`/`InnerBorder` (grounded
  // in `Control.Toolbar.js:39-152` `getBorderStyleUNOCommand`; mirrored in
  // `packages/agent/src/tools/office/office.ts:3821` `borderPresetArgs`). The
  // surface JSON-stringifies whatever's in `Values.Args`, so complex values
  // flow through unchanged.
  sendUnoArgs: (
    command: string,
    args: Record<string, { type: string; value: unknown }>,
  ) => void;
  isActive: (bareCommand: string) => boolean;
  stateValue: (bareCommand: string) => string;
  // D362 §5 — dispatch a Collabora browser-side action id into the same-origin
  // editor iframe (e.g. `fullscreen-presentation`). Replaces the old
  // `.uno:Presentation` core-slideshow path (which produced an un-exitable
  // "giant slide"). Returns true if the dispatcher was reachable and called.
  dispatchClientAction: (action: string) => boolean;
  // D362 §5b — end the running canvas slideshow. Calls the canvas path
  // (`map.slideShowPresenter.endPresentation(true)`) AND sends
  // `.uno:PresentationEnd` as a belt-and-braces core-path kill switch (no-op
  // if the core slideshow isn't running). Used by the parent-side "Exit
  // presentation" button (visible while `presenting` is true).
  exitPresentation: () => void;
  // D362 §5b — true while the canvas slideshow is running. Gates the
  // parent-side Exit button. Subscribed via `subscribePresentationState`.
  presenting: boolean;
}

export interface RibbonTabDef {
  id: string;
  label: string;
}

/**
 * §3.3.5 — the tabbed-ribbon tab strip (Home / Insert / …). The active tab's
 * group content is rendered by the host surface, not here. Tabs earn their
 * place at Calc/Impress density; Writer retrofits into the same shell.
 */
export function RibbonTabStrip({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly RibbonTabDef[];
  active: string;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <div role="tablist" aria-label="Ribbon tabs" className="flex items-center gap-0.5 border-b border-border/60 px-2 pt-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={
            active === t.id
              ? "-mb-px rounded-t border-b-2 border-primary px-3 py-1 text-xs font-medium text-primary"
              : "rounded-t px-3 py-1 text-xs text-foreground-muted hover:bg-muted/50 hover:text-foreground"
          }
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * §3.3.5 — a popover anchored to a trigger button, PORTALED to <body> so it
 * escapes the office header's `overflow-hidden` clip (Find / color / table /
 * link panels were getting cut off). Fixed-positioned off the trigger rect;
 * dismiss on outside-click or Escape. Clicks inside the doc iframe never reach
 * our document, so a panel meant to persist while working (Find) stays open
 * when you click into the page.
 */
export function AnchoredPopover({
  open,
  onClose,
  anchorRef,
  align = "left",
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: "left" | "right";
  children: React.ReactNode;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  // `pos` is an absolute (top, left) clamped into the viewport. Until the
  // first measure completes we render the portal invisibly at (0,0) so its
  // size can be read by `useLayoutEffect` (which runs before browser paint,
  // so the user never sees the hidden frame).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const MARGIN = 8;
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const panel = panelRef.current;
      // Width/height are stable across position changes (fixed box), so
      // measuring the panel never induces a re-render loop.
      const pw = panel?.getBoundingClientRect().width ?? 0;
      const ph = panel?.getBoundingClientRect().height ?? 0;
      // Preferred edge from `align`: "left" tucks the panel under the
      // anchor's left edge; "right" aligns the panel's right edge with the
      // anchor's right edge.
      const preferredLeft = align === "right" ? r.right - pw : r.left;
      let left = preferredLeft;
      if (pw > 0) {
        const maxLeft = vw - pw - MARGIN;
        if (left > maxLeft) left = maxLeft;
        if (left < MARGIN) left = MARGIN;
      }
      // Preferred top is just below the anchor. If the panel would overflow
      // the bottom, flip it above the anchor; if neither fits, pin to the
      // bottom margin so it stays on-screen.
      let top = r.bottom + 4;
      if (ph > 0 && top + ph > vh - MARGIN) {
        const aboveTop = r.top - 4 - ph;
        if (aboveTop >= MARGIN) top = aboveTop;
        else top = Math.max(MARGIN, vh - ph - MARGIN);
      }
      setPos((prev) =>
        prev && prev.top === top && prev.left === left ? prev : { top, left },
      );
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, anchorRef, align]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);
  if (!open) return null;
  // Before the first measure (`pos` null) we render the portal invisibly so
  // its rect can be read without flashing it at the wrong spot.
  const style: React.CSSProperties = pos
    ? { position: "fixed", top: pos.top, left: pos.left, zIndex: 50 }
    : { position: "fixed", top: 0, left: 0, visibility: "hidden", zIndex: 50 };
  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      style={style}
      className="rounded-md border border-border bg-background-panel p-2 shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * §3.3.5-C — a toolbar color button that opens a swatch popover. Dispatchs
 * `.uno:FontColor` / `.uno:CharBackColor` with the `<Command>.Color` long arg
 * (grounded in Collabora `Widget.ColorPickerButton.js`); `-1` = automatic/none.
 */
export function ColorSwatchMenu({
  title,
  Icon,
  autoLabel,
  disabled,
  currentColor,
  onPick,
}: {
  title: string;
  Icon: LucideIcon;
  autoLabel: string;
  disabled: boolean;
  currentColor: string | null;
  onPick: (value: number) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        className={`relative ${toolbarButtonClass(open)}`}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Icon renders as the flow child (identical box to sibling icon
            buttons → 26px, keeps the Font row aligned). The color indicator is
            an absolute overlay inside the button padding, so it never inflates
            the button height. */}
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        <span
          className="pointer-events-none absolute inset-x-1 bottom-1 h-[3px] rounded-sm"
          style={{ backgroundColor: currentColor ?? "transparent" }}
        />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <button
          type="button"
          className="mb-1.5 block w-full rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted"
          onClick={() => {
            onPick(-1);
            setOpen(false);
          }}
        >
          {autoLabel}
        </button>
        <div className="grid grid-cols-8 gap-1">
          {COLOR_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              title={hex}
              aria-label={hex}
              className="h-4 w-4 rounded border border-border/60 hover:scale-110"
              style={{ backgroundColor: hex }}
              onClick={() => {
                onPick(Number.parseInt(hex.slice(1), 16));
                setOpen(false);
              }}
            />
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * D362 §3.1b — chrome-strip CSS injected into the editor document to remove the
 * Collabora chrome that postMessage CANNOT hide (classic toolbar, status bar,
 * welcome splash, nav control), leaving only the tile canvas. This ONLY works
 * when the iframe is **same-origin** (via the coolwsd reverse-proxy); on a
 * cross-origin iframe `contentDocument` access throws and we no-op safely (the
 * postMessage strip of menubar/sidebar/ruler still applies). Selectors target
 * Collabora's DOM, so the engine image is pinned; a major upgrade may need a
 * selector tweak (cosmetic, degrades safely). Live-tuned against the pinned
 * CODE image.
 */
const OFFICE_CHROME_STRIP_CSS_HREF = "/office-engine/nw-strip.css";

/** Inject (idempotently) the chrome-strip stylesheet into a same-origin editor iframe. */
export function injectChromeStrip(iframe: HTMLIFrameElement | null): void {
  if (!iframe) return;
  let doc: Document | null = null;
  try {
    doc = iframe.contentDocument;
  } catch {
    return; // cross-origin (pre-proxy): can't reach the DOM; postMessage strip still applies
  }
  if (!doc) return;
  const LINK_ID = "nw-office-chrome-strip";
  if (doc.getElementById(LINK_ID)) return;
  const link = doc.createElement("link");
  link.id = LINK_ID;
  link.rel = "stylesheet";
  link.href = OFFICE_CHROME_STRIP_CSS_HREF;
  (doc.head ?? doc.documentElement).appendChild(link);
}

export function iframeHasDocumentCanvas(iframe: HTMLIFrameElement | null): boolean {
  try {
    return Boolean(iframe?.contentDocument?.querySelector("#document-canvas"));
  } catch {
    return false;
  }
}

export type CollaboraMapLike = {
  fire?: (eventName: string) => void;
  focus?: (acceptInput?: boolean) => void;
  // Truthy while ANY IFrameDialog (welcome splash, feedback, settings) is
  // registered — even one our strip CSS has made invisible. While set,
  // `editorHasFocus()` is false and Collabora force-hides the text cursor.
  _iframeDialog?: unknown;
  // Zoom is a CLIENT operation in Collabora Online (`map.setZoom`), not a UNO
  // command — sending `.uno:ZoomPlus` over Send_UNO_Command is a no-op. Drive
  // it directly on the map instead.
  zoomIn?: (delta?: number) => void;
  zoomOut?: (delta?: number) => void;
  setZoom?: (zoom: number, options?: unknown) => void;
  getZoom?: () => number;
  // Switch the active part (Calc sheet / Impress slide) client-side —
  // Collabora's `map.setPart(n)` (browser/src/control/Parts.js). Also accepts
  // 'next' / 'prev'. Fires `updateparts`, which `subscribePartState` listens to.
  setPart?: (part: number | "next" | "prev") => void;
  // Request a part (slide/sheet) preview render. Fires `tilepreview` with the
  // rendered image once ready; `{autoUpdate:true}` re-fires on edit. No-op for
  // text docs (browser/src/control/Parts.js:220-268 early-returns _docType text).
  getPreview?: (
    id: number,
    part: number,
    maxWidth: number,
    maxHeight: number,
    options?: { autoUpdate?: boolean; fetchThumbnail?: boolean },
  ) => { width: number; height: number } | undefined;
  _docLayer?: {
    _updateCursorAndOverlay?: () => void;
    _parts?: number;
    // Collabora's own "fit page width" (browser/src/layer/tile/CanvasTileLayer.js).
    // Computes zoom = getScaleZoom(paneWidth / documentWidth), clamped to the
    // Writer max (13). It early-returns / keeps the current zoom once its
    // one-time first-fit is done UNLESS recalcFirstFit (3rd arg) is true —
    // which resets `_firstFitDone` and forces a recompute against the CURRENT
    // viewport. This is the canonical path behind the "Fit Page Width" action
    // (ViewLayout.adjustViewZoomLevel → _fitWidthZoom(undefined, undefined, true)).
    _fitWidthZoom?: (e?: unknown, maxZoom?: number, recalcFirstFit?: boolean) => void;
  };
  _textInput?: {
    showCursor?: () => void;
  };
  // §3.3.6 state-in — Collabora's map is a Leaflet Evented; it fires
  // `commandstatechanged` with `{ commandName, state }` on every
  // selection/cursor move (browser/src/map/handler/Map.StateChanges.js).
  // `stateChangeHandler.getItems()` holds the last value for every tracked
  // command so we can SEED current state on subscribe.
  on?: (event: string, fn: (e: CommandStateEvent) => void, context?: unknown) => void;
  off?: (event: string, fn: (e: CommandStateEvent) => void, context?: unknown) => void;
  stateChangeHandler?: { getItems?: () => Record<string, unknown> };
};

export type CommandStateEvent = { commandName?: string; state?: unknown };

/**
 * Commands whose live state we reflect onto our toolbar (§3.3.6). Toggles
 * light up the matching button; the value-carrying ones (style/font/size)
 * are stored for the §3.3.5 dropdowns. Keys are bare (no `.uno:` prefix)
 * to match how we send them; we normalize the prefix when reading.
 */
/** §3.3.5-D — insert a table via a small rows×columns popover. */
export function InsertTableMenu({
  disabled,
  onInsert,
}: {
  disabled: boolean;
  onInsert: (cols: number, rows: number) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(2);
  const btnRef = useRef<HTMLButtonElement>(null);
  const clamp = (n: number) => Math.max(1, Math.min(20, Math.round(Number.isFinite(n) ? n : 1)));
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Insert table"
        aria-label="Insert table"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        className={toolbarButtonClass(open)}
        onClick={() => setOpen((v) => !v)}
      >
        <TableIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="flex items-center gap-2 text-xs text-foreground">
          <label className="flex items-center gap-1">
            Cols
            <input
              type="number"
              min={1}
              max={20}
              value={cols}
              onChange={(e) => setCols(clamp(Number(e.target.value)))}
              className="w-12 rounded border border-border bg-background-element px-1 py-0.5 text-xs"
            />
          </label>
          <label className="flex items-center gap-1">
            Rows
            <input
              type="number"
              min={1}
              max={20}
              value={rows}
              onChange={(e) => setRows(clamp(Number(e.target.value)))}
              className="w-12 rounded border border-border bg-background-element px-1 py-0.5 text-xs"
            />
          </label>
          <button
            type="button"
            className="rounded bg-background-interactive px-2 py-0.5 text-xs text-foreground hover:bg-muted"
            onClick={() => {
              onInsert(clamp(cols), clamp(rows));
              setOpen(false);
            }}
          >
            Insert
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}

/** §3.3.5-D — insert a hyperlink via a text + URL popover (`.uno:SetHyperlink`). */
export function InsertLinkMenu({
  disabled,
  onInsert,
}: {
  disabled: boolean;
  onInsert: (text: string, url: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const submit = () => {
    const trimmed = url.trim();
    if (trimmed === "") return;
    onInsert(text.trim(), trimmed);
    setOpen(false);
    setText("");
    setUrl("");
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Insert link"
        aria-label="Insert link"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        className={toolbarButtonClass(open)}
        onClick={() => setOpen((v) => !v)}
      >
        <LinkIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="w-64">
          <input
            type="text"
            placeholder="Text to display (optional)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mb-1.5 w-full rounded border border-border bg-background-element px-2 py-1 text-xs"
          />
          <input
            type="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className="mb-1.5 w-full rounded border border-border bg-background-element px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={url.trim() === ""}
            className="w-full rounded bg-background-interactive px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
            onClick={submit}
          >
            Insert link
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * §3.3.5-E — find & replace panel driving `.uno:ExecuteSearch`
 * (`SearchItem.*` args grounded in Collabora `SearchService.ts`;
 * Command 0=find, 2=replace, 3=replace-all). Unlike the other popovers it
 * stays open while iterating (find-next), dismissing only on Escape/close.
 */
export function FindReplaceMenu({
  disabled,
  onSearch,
}: {
  disabled: boolean;
  onSearch: (term: string, backward: boolean, replace: string, command: number) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const canFind = findText !== "";
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Find & replace"
        aria-label="Find & replace"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        className={toolbarButtonClass(open)}
        onClick={() => setOpen((v) => !v)}
      >
        <Search aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef} align="right">
        <div className="w-72">
          <div className="mb-1.5 flex items-center gap-1">
            <input
              autoFocus
              type="text"
              placeholder="Find"
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (canFind) onSearch(findText, e.shiftKey, "", 0);
                }
              }}
              className="min-w-0 flex-1 rounded border border-border bg-background-element px-2 py-1 text-xs"
            />
            <button type="button" title="Find previous" aria-label="Find previous" disabled={!canFind} className={toolbarButtonClass()} onClick={() => onSearch(findText, true, "", 0)}>
              <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <button type="button" title="Find next" aria-label="Find next" disabled={!canFind} className={toolbarButtonClass()} onClick={() => onSearch(findText, false, "", 0)}>
              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              placeholder="Replace with"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background-element px-2 py-1 text-xs"
            />
            <button type="button" disabled={!canFind} className="shrink-0 rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40" onClick={() => onSearch(findText, false, replaceText, 2)}>
              Replace
            </button>
            <button type="button" disabled={!canFind} className="shrink-0 rounded px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40" onClick={() => onSearch(findText, false, replaceText, 3)}>
              All
            </button>
          </div>
        </div>
      </AnchoredPopover>
    </>
  );
}

export const TRACKED_STATE_COMMANDS = [
  "Bold", "Italic", "Underline",
  "Strikeout", "SubScript", "SuperScript",
  "DefaultBullet", "DefaultNumbering",
  "LeftPara", "CenterPara", "RightPara", "JustifyPara",
  "StyleApply", "CharFontName", "FontHeight",
  "FontColor", "CharBackColor",
  // Wave C — Calc/Impress STATE toggles reflected onto their ribbon groups.
  "WrapText", "ToggleMergeCells", "FreezePanes", "DataFilterAutoFilter",
  "NumberFormatCurrency", "NumberFormatPercent", "NumberFormatDate",
  "NotesMode", "TrackChanges",
] as const;

/** Normalize a Collabora command name to its bare form (drop `.uno:`). */
function bareCommand(name: string): string {
  return name.startsWith(".uno:") ? name.slice(5) : name;
}

/** True iff a tracked toggle's state value means "on". */
export function isUnoActive(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Reduce a single `commandstatechanged` event into the tracked-state map.
 * Returns the same reference when the command isn't tracked (lets callers
 * skip a re-render). Pure — unit-tested.
 */
export function reduceCommandState(
  prev: Record<string, unknown>,
  commandName: string | undefined,
  state: unknown,
): Record<string, unknown> {
  if (!commandName) return prev;
  const bare = bareCommand(commandName);
  if (!TRACKED_STATE_COMMANDS.includes(bare as (typeof TRACKED_STATE_COMMANDS)[number])) return prev;
  if (prev[bare] === state) return prev;
  return { ...prev, [bare]: state };
}

/**
 * Subscribe to the editor's live command-state (§3.3.6). Seeds from the
 * state handler's current items, then listens for `commandstatechanged`.
 * Returns an unsubscribe fn (no-op if the map wasn't reachable/ready).
 */
export function subscribeCommandState(
  iframe: HTMLIFrameElement | null,
  onState: (commandName: string, state: unknown) => void,
): (() => void) | null {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow);
    if (!map?.on) return null;
    // Seed current values so toggles are correct before the first change.
    const items = map.stateChangeHandler?.getItems?.();
    if (items) {
      for (const [name, value] of Object.entries(items)) onState(name, value);
    }
    const handler = (e: CommandStateEvent) => {
      if (e.commandName !== undefined) onState(e.commandName, e.state);
    };
    map.on("commandstatechanged", handler);
    return () => {
      try {
        map.off?.("commandstatechanged", handler);
      } catch {
        // map torn down with the iframe — nothing to detach.
      }
    };
  } catch {
    return null;
  }
}

/**
 * D362 audit C2 fix — subscribe to coolwsd's background-save completion signal
 * so the "unsaved" indicator clears after an AutoSave. The surface's postMessage
 * handler already clears on `Action_Save_Resp` (explicit user Save) and
 * `Doc_ModifiedStatus: false` (which coolwsd only emits after an explicit save);
 * AutoSave fires NEITHER, so without this subscription the chrome stays
 * "Unsaved" indefinitely after a background PutFile.
 *
 * Grounded in `EXTERNAL/collabora-online-source/browser/src/app/Socket.ts:2376-
 * 2399` (`_onProgressMsg` — parses `progress: ` socket messages and re-fires
 * them as the map's `statusindicator` event with `{ statusType, background }`),
 * and `EXTERNAL/collabora-online-source/browser/src/map/Map.js:1472-1493`
 * (`_onUpdateProgress` — on `statusType === 'finish'` with `e.background === true`
 * it calls `saveState.showSavedStatus()`, the SAME path Collabora's own status
 * bar uses to flip "Saving" → "Saved" after a background AutoSave). The audit's
 * suggested event name was `saved`; that event does not exist on the coolwsd
 * map — `statusindicator` finish+background is the actual signal (see report).
 *
 * Returns an unsubscribe fn (null if the map isn't reachable/ready).
 */
export function subscribeBackgroundSave(
  iframe: HTMLIFrameElement | null,
  onSaved: () => void,
  onSaving?: () => void,
): (() => void) | null {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow) as unknown as {
      on?: (event: string, fn: (ev: { statusType?: string; background?: boolean }) => void) => void;
      off?: (event: string, fn: (ev: { statusType?: string; background?: boolean }) => void) => void;
    } | null;
    if (!map?.on) return null;
    const handler = (ev: { statusType?: string; background?: boolean }): void => {
      if (ev?.background !== true) return;
      // Background-save lifecycle, grounded in Map.js `_onUpdateProgress`
      // (browser/src/map/Map.js:1479-1490): `start` → showSavingStatus(),
      // `finish` → showSavedStatus(). Same coolwsd `statusindicator` event —
      // no new event invented.
      if (ev.statusType === "start") onSaving?.();
      else if (ev.statusType === "finish") onSaved();
    };
    map.on("statusindicator", handler);
    return () => {
      try {
        map.off?.("statusindicator", handler);
      } catch {
        // map torn down with the iframe — nothing to detach.
      }
    };
  } catch {
    return null;
  }
}

/**
 * Wave C (Calc) — subscribe to the editor's active-cell address + formula.
 * Core pushes `celladdress:` / `cellformula:` socket messages; the browser
 * re-fires them as `celladdress` `{address}` / `cellformula` `{formula}` map
 * events (grounded in Collabora `CanvasTileLayer.js` `_onCellAddressMsg` /
 * `_onCellFormulaMsg`). Returns an unsubscribe fn (null if the map isn't ready).
 */
export function subscribeCellState(
  iframe: HTMLIFrameElement | null,
  onAddress: (address: string) => void,
  onFormula: (formula: string) => void,
): (() => void) | null {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow) as unknown as {
      on?: (e: string, fn: (ev: { address?: string; formula?: string }) => void) => void;
      off?: (e: string, fn: (ev: { address?: string; formula?: string }) => void) => void;
    } | null;
    if (!map?.on) return null;
    const onAddr = (ev: { address?: string }) => {
      if (ev.address !== undefined) onAddress(ev.address);
    };
    const onForm = (ev: { formula?: string }) => {
      if (ev.formula !== undefined) onFormula(ev.formula);
    };
    map.on("celladdress", onAddr);
    map.on("cellformula", onForm);
    return () => {
      try {
        map.off?.("celladdress", onAddr);
        map.off?.("cellformula", onForm);
      } catch {
        // map torn down with the iframe.
      }
    };
  } catch {
    return null;
  }
}

/** Snapshot of the document's part list (Calc sheets / Impress slides). */
export interface PartStateSnapshot {
  /** Number of parts (sheets / slides). */
  count: number;
  /** 0-based index of the active part. */
  selectedPart: number;
  /** Part names in order (Calc sheet names). Empty until the engine sends them. */
  names: string[];
}

/**
 * Wave C — subscribe to the document's part list + active part. Calc sheets and
 * Impress slides are both "parts": Core tracks `docLayer._parts` (count),
 * `_selectedPart` (active, 0-based), and `_partNames` (Calc sheet names). The
 * map re-fires `updateparts` `{ selectedPart, parts }` on switch and
 * `insertpage` / `deletepage` on structural change (grounded in Collabora
 * `browser/src/control/Parts.js` `setPart` / `insertPage` / `deletePage`).
 * Seeds immediately, then listens. Returns an unsubscribe fn (null if the map
 * isn't reachable).
 */
export function subscribePartState(
  iframe: HTMLIFrameElement | null,
  onParts: (snap: PartStateSnapshot) => void,
): (() => void) | null {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow);
    if (!map?.on) return null;
    const read = (): void => {
      const dl = map._docLayer as unknown as {
        _parts?: number;
        _selectedPart?: number;
        _partNames?: string[];
      } | undefined;
      if (!dl) return;
      const names = Array.isArray(dl._partNames) ? [...dl._partNames] : [];
      onParts({
        count: typeof dl._parts === "number" ? dl._parts : names.length,
        selectedPart: typeof dl._selectedPart === "number" ? dl._selectedPart : 0,
        names,
      });
    };
    read();
    map.on("updateparts", read);
    map.on("insertpage", read);
    map.on("deletepage", read);
    return () => {
      try {
        map.off?.("updateparts", read);
        map.off?.("insertpage", read);
        map.off?.("deletepage", read);
      } catch {
        // map torn down with the iframe.
      }
    };
  } catch {
    return null;
  }
}

/**
 * Payload of Collabora's `tilepreview` event. The engine renders a requested
 * part to an `<img>` and fires this; `id` is the correlation id we passed to
 * `getPreview` (we use id === 0-based part index), `tile` is the image element
 * whose `.src` is the rendered data/blob URL. Grounded:
 * `browser/src/app/TilesMiddleware.ts:1906` (fire) +
 * `browser/src/control/Control.PartsPreview.js:625` (`e.tile.src`).
 */
export interface TilePreviewEvent {
  // NOTE: `id` round-trips through the tile wire message as a STRING ("0"),
  // even though getPreview is called with a numeric id — parseServerCmd keeps
  // it as text. Coerce before use (live-verified 2026-07-05).
  id?: number | string;
  part?: number;
  tile?: { src?: string };
}

/**
 * Wave C — feed LIVE slide thumbnails into our Impress rail (replacing the
 * numbered placeholders) so we can suppress Collabora's own `#navigation-sidebar`
 * and keep a single on-brand navigator. Collabora renders each part via
 * `map.getPreview(id, part, w, h, {autoUpdate:true})` and fires `tilepreview
 * {tile, id}` when ready; `autoUpdate` re-fires on every edit/invalidation, so
 * thumbnails stay live for free once requested. We request one preview per
 * current part (keyed id === part index), re-request when the part list changes
 * (insertpage/deletepage/updateparts), and forward each `tile.src` to
 * `onPreview(index, src)`. No-op for text docs (getPreview early-returns).
 * Returns an unsubscribe fn (null if the map isn't reachable / lacks getPreview).
 */
export function subscribeSlidePreviews(
  iframe: HTMLIFrameElement | null,
  onPreview: (index: number, src: string) => void,
  opts?: { maxWidth?: number; maxHeight?: number },
): (() => void) | null {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow);
    if (!map?.on || typeof map.getPreview !== "function") return null;
    const maxWidth = opts?.maxWidth ?? 120;
    const maxHeight = opts?.maxHeight ?? 90;
    const requestAll = (): void => {
      const dl = map._docLayer as { _parts?: number } | undefined;
      const count = typeof dl?._parts === "number" ? dl._parts : 0;
      for (let i = 0; i < count; i++) {
        try {
          map.getPreview?.(i, i, maxWidth, maxHeight, { autoUpdate: true });
        } catch {
          // A single bad part shouldn't abort requesting the rest.
        }
      }
    };
    const onTile = (e: TilePreviewEvent): void => {
      const src = e?.tile?.src;
      // `e.id` arrives as a string ("0") off the wire — coerce to the 0-based
      // part index it correlates to.
      const idNum = typeof e?.id === "number" ? e.id : Number(e?.id);
      if (Number.isInteger(idNum) && idNum >= 0 && typeof src === "string" && src.length > 0) {
        onPreview(idNum, src);
      }
    };
    // The map's `on`/`off` are typed for CommandStateEvent; the tilepreview /
    // part events carry different shapes, so cast at the boundary (same handler
    // reference is reused for off()).
    const tileHandler = onTile as unknown as (e: CommandStateEvent) => void;
    const reqHandler = requestAll as unknown as (e: CommandStateEvent) => void;
    map.on("tilepreview", tileHandler);
    map.on("insertpage", reqHandler);
    map.on("deletepage", reqHandler);
    map.on("updateparts", reqHandler);
    requestAll();
    return () => {
      try {
        map.off?.("tilepreview", tileHandler);
        map.off?.("insertpage", reqHandler);
        map.off?.("deletepage", reqHandler);
        map.off?.("updateparts", reqHandler);
      } catch {
        // map torn down with the iframe.
      }
    };
  } catch {
    return null;
  }
}

export function collaboraMapFromWindow(win: Window | null | undefined): CollaboraMapLike | null {
  if (!win) return null;
  const record = win as unknown as {
    app?: { map?: CollaboraMapLike };
    map?: CollaboraMapLike;
  };
  return record.app?.map ?? record.map ?? null;
}

/**
 * Trigger Collabora's OWN local-image insert flow: a browser file picker →
 * Collabora reads the chosen file and uploads it to the core over its socket
 * (Map.FileInserter). The engine's own toolbar does this by clicking a hidden
 * `#insertgraphic` file input (docdispatcher `localgraphic` action:
 * `L.DomUtil.get('insertgraphic').click()`), NOT by dispatching
 * `.uno:InsertGraphic` — sending that raw UNO command over Send_UNO_Command
 * surfaces no usable picker in the embedded/headless context (which is why the
 * button did nothing). We click that input directly (same-origin via the office
 * proxy); the input + its change→onInsertGraphic handler are created at map init
 * regardless of our chrome-strip. Grounded: browser/src/control/docdispatcher.ts:183,
 * Control.Toolbar.js:809/1095-1098, Map.FileInserter.js. Returns true if fired.
 * NOTE: agent-side image insert is a separate path (Action_InsertGraphic{url} +
 * a hosted asset URL) — tracked as Wave K, not this human-button fix.
 */
export function triggerLocalImageInsert(iframe: HTMLIFrameElement | null): boolean {
  try {
    const doc = iframe?.contentDocument;
    const input = doc?.getElementById("insertgraphic") as HTMLInputElement | null;
    if (input) {
      input.click();
      return true;
    }
    // Fallback to the dispatcher action if the input id ever changes upstream.
    const win = iframe?.contentWindow as unknown as {
      app?: { dispatcher?: { dispatch?: (action: string) => void } };
    } | null;
    const dispatcher = win?.app?.dispatcher;
    if (dispatcher && typeof dispatcher.dispatch === "function") {
      dispatcher.dispatch("localgraphic");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * D362 §5a — dispatch a Collabora browser-side action id into the same-origin
 * editor iframe (e.g. `fullscreen-presentation`, `presentation-currentslide`,
 * `present-in-window`). This is the SAME path Collabora's own menubar uses
 * (`EXTERNAL/collabora-online-source/browser/src/control/Control.Menubar.ts:2337`
 * — `app.dispatcher.dispatch('fullscreen-presentation')`), which `docdispatcher.ts:511-537`
 * maps to `app.map.fire('newfullscreen')` → `SlideShowPresenter._onStart`
 * (`SlideShowPresenter.ts:172, 1159-1171`) → the browser-side canvas slideshow
 * with the End Show button + Escape handler.
 *
 * Replaces the old `.uno:Presentation` Send_UNO_Command path, which is a
 * LibreOffice *core* slot (`SID_PRESENTATION`) that runs the in-core
 * `ShowWindow` slideshow (`sd/source/ui/view/drviewse.cxx:831-838`) — an
 * un-exitable "giant slide" with no browser-side End Show / Escape.
 *
 * Same-origin via the `/office-engine` reverse-proxy (same path as
 * `triggerLocalImageInsert`). Returns true if the dispatcher was reachable
 * and called; false if the iframe isn't ready / is cross-origin / lacks the
 * dispatcher (the caller can fall back to a retry or an error toast).
 */
export function dispatchOfficeAction(iframe: HTMLIFrameElement | null, action: string): boolean {
  try {
    const win = iframe?.contentWindow as unknown as {
      app?: { dispatcher?: { dispatch?: (action: string) => void } };
    } | null;
    const dispatcher = win?.app?.dispatcher;
    if (dispatcher && typeof dispatcher.dispatch === "function") {
      dispatcher.dispatch(action);
      return true;
    }
    return false;
  } catch {
    // cross-origin / not-ready: caller can retry or surface an error.
    return false;
  }
}

/**
 * D362 §5b — end the running canvas slideshow via Collabora's own exit path.
 * `app.map.slideShowPresenter.endPresentation(true)` is the SAME method
 * Collabora's `#endshow` End Show button + Escape keydown +
 * `_onFullScreenChange` (fullscreen-loss) all funnel into
 * (`SlideShowPresenter.ts:802-822` → `_stopFullScreen()` +
 * `_closeSlideShowWindow()`). Returns true if the canvas-path call was
 * dispatched; the caller is still expected to also send
 * `.uno:PresentationEnd` as a belt-and-braces core-path kill switch
 * (`drviewse.cxx:840-846` → `StopSlideShow()` → `xPresentation->end()`).
 */
export function endOfficePresentation(iframe: HTMLIFrameElement | null): boolean {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow) as unknown as
      | { slideShowPresenter?: { endPresentation?: (force: boolean) => void } }
      | null;
    const presenter = map?.slideShowPresenter;
    if (presenter && typeof presenter.endPresentation === "function") {
      presenter.endPresentation(true);
      return true;
    }
    return false;
  } catch {
    // cross-origin / not-ready / no presenter yet — caller's UNO fallback covers it.
    return false;
  }
}

/**
 * D362 §5b — true iff the canvas slideshow is currently running. Mirrors
 * `SlideShowPresenter._checkAlreadyPresenting()`
 * (`SlideShowPresenter.ts:1074-1077` — true iff `this._slideShowCanvas` is
 * set). Used both to seed `presenting` and to re-evaluate after a
 * `fullscreenchange` event.
 */
function isOfficePresenting(iframe: HTMLIFrameElement | null): boolean {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow) as unknown as
      | { slideShowPresenter?: { _checkAlreadyPresenting?: () => boolean } }
      | null;
    const presenter = map?.slideShowPresenter;
    if (presenter && typeof presenter._checkAlreadyPresenting === "function") {
      return Boolean(presenter._checkAlreadyPresenting());
    }
    // Fall back to the DOM marker the canvas slideshow creates
    // (`_createPresenterHTML` → `#slideshow-canvas`,
    // `SlideShowPresenter.ts:485-558`). Same-origin only; cross-origin falls
    // through to false.
    const doc = iframe?.contentDocument;
    return Boolean(doc?.querySelector("#slideshow-canvas"));
  } catch {
    return false;
  }
}

/**
 * D362 §5b — subscribe to the canvas slideshow's running state so the
 * parent-side "Exit presentation" button shows ONLY while presenting.
 *
 * Signals:
 * - `presentationinfo` map event (`SlideShowPresenter.ts:171, 1193`) — fired
 *   on `getpresentationinfo` response, which `_onStart`/`_onStartInWindow`
 *   send immediately after the canvas slideshow prepares the screen
 *   (`:1170, :1187`). Treat as "presenting = true".
 * - `fullscreenchange` on the iframe's `document` (`SlideShowPresenter.ts:174-179`
 *   binds its own `_onFullScreenChange` here) — re-evaluate
 *   `_checkAlreadyPresenting()`; if false, the user exited fullscreen (Esc /
 *   F11) → `slideShowNavigator.quit()` → `endPresentation(true)` has run, so
 *   treat as "presenting = false".
 * - `endpresentation` map event (`SlideShowPresenter.ts:194, 268-276`) — fired
 *   for follow-mode exits; treat as "presenting = false".
 *
 * Seeds the current state on attach. Returns an unsubscribe fn (null if the
 * map isn't reachable/ready).
 */
export function subscribePresentationState(
  iframe: HTMLIFrameElement | null,
  onPresentingChange: (presenting: boolean) => void,
): (() => void) | null {
  try {
    const map = collaboraMapFromWindow(iframe?.contentWindow) as unknown as
      | {
          on?: (event: string, fn: (ev: unknown) => void) => void;
          off?: (event: string, fn: (ev: unknown) => void) => void;
        }
      | null;
    if (!map?.on) return null;
    const onInfo = (): void => onPresentingChange(true);
    const onEnd = (): void => onPresentingChange(false);
    const onFsChange = (): void => onPresentingChange(isOfficePresenting(iframe));
    map.on("presentationinfo", onInfo);
    map.on("endpresentation", onEnd);
    // The fullscreenchange listener attaches to the IFRAME's document (where
    // Collabora's own _onFullScreenChange listens). Same-origin only; if the
    // iframe is cross-origin the addEventListener throws and we skip it (the
    // map events above still fire).
    let iframeDoc: Document | null = null;
    try {
      iframeDoc = iframe?.contentDocument ?? null;
    } catch {
      iframeDoc = null;
    }
    if (iframeDoc) iframeDoc.addEventListener("fullscreenchange", onFsChange);
    // Seed current state.
    onPresentingChange(isOfficePresenting(iframe));
    return () => {
      try {
        map.off?.("presentationinfo", onInfo);
        map.off?.("endpresentation", onEnd);
        if (iframeDoc) iframeDoc.removeEventListener("fullscreenchange", onFsChange);
      } catch {
        // map / iframe torn down — nothing to detach.
      }
    };
  } catch {
    return null;
  }
}

/**
 * Dismiss the CODE welcome splash through Collabora's own close path.
 *
 * Root cause of the "cursor gets eaten" bug (verified live 2026-07-03): the
 * welcome splash loads as an `IFrameDialog` even though our strip CSS hides it
 * visually and `--o:welcome.enable=false` does not suppress it. While
 * `map._iframeDialog` is set, `editorHasFocus()` returns false and
 * `_updateCursorAndOverlay()` calls `hideCursor()` on every update — typing
 * works but the blinking caret is force-detached. Posting `welcome-close` into
 * the editor window is exactly what Collabora's own Escape handler does
 * (browser/src/control/IFrameDialog.js); the welcome handler also persists
 * `WSDWelcomeVersion` so the splash stays gone on future loads.
 */
function dismissWelcomeDialog(iframe: HTMLIFrameElement | null): boolean {
  const win = iframe?.contentWindow;
  if (!win) return false;
  try {
    const map = collaboraMapFromWindow(win);
    if (!map?._iframeDialog) return false;
    win.postMessage(JSON.stringify({ MessageId: "welcome-close" }), "*");
    return true;
  } catch {
    // Cross-origin / not-ready: the next retry tick will handle it.
    return false;
  }
}

/**
 * Fit the document to the current pane width. On load Collabora runs a
 * one-time "first fit" that computes zoom from the iframe's viewport width
 * AT THAT MOMENT. If the office pane is still mid-layout (chat panel
 * animating, grid unsettled) it fits against a wrong width and lands on a
 * tiny zoom (observed live: zoom 3), rendering the page as a small
 * rectangle; and it never re-fits on its own once `_firstFitDone` is set.
 *
 * We drive Collabora's OWN fit-page-width path with `recalcFirstFit=true`,
 * which resets `_firstFitDone` and recomputes zoom = fit(paneWidth /
 * documentWidth) against the current viewport — exactly what the built-in
 * "Fit Page Width" action does. Idempotent enough to call across the load
 * window and on pane resizes; callers gate it on an actual width change so
 * a settled document isn't re-fit (which would cause a scroll jump).
 */
export function fitEditorWidth(iframe: HTMLIFrameElement | null): void {
  try {
    const dl = collaboraMapFromWindow(iframe?.contentWindow)?._docLayer;
    dl?._fitWidthZoom?.(undefined, undefined, true);
  } catch {
    // cross-origin / not-ready: a later tick / resize retries.
  }
}

/**
 * True iff focus currently sits in a text-entry element OUTSIDE the editor
 * iframe (the chat composer, a rename field, any input/textarea/select or
 * contenteditable in the parent document). Used to gate the automatic
 * post-load focus so the loading document never yanks focus away from a
 * user who is mid-sentence in the chat box.
 */
export function focusIsInExternalTextEntry(iframe: HTMLIFrameElement | null): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  if (active === iframe) return false; // the editor already holds focus
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return active.isContentEditable === true;
}

export function focusEditorFrame(iframe: HTMLIFrameElement | null): void {
  if (!iframe) return;
  try {
    iframe.contentWindow?.focus();
    const map = collaboraMapFromWindow(iframe.contentWindow);
    // The invisible welcome IFrameDialog wedges `editorHasFocus()` to false,
    // which makes Collabora hide the caret on every cursor update. Close it
    // first or the focus calls below are undone immediately.
    dismissWelcomeDialog(iframe);
    // Collabora only keeps the Writer cursor visible when its map focus state is
    // back on the editor (`winId === 0`). Focusing the hidden DOM node can accept
    // input while leaving the cursor overlay hidden, so use Collabora's own focus
    // path first, then reattach the blinking cursor.
    map?.fire?.("editorgotfocus");
    map?.focus?.(true);
    const doc = iframe.contentDocument;
    const clipboard = doc?.getElementById("clipboard-area");
    if (clipboard instanceof HTMLElement) {
      clipboard.focus();
    } else {
      const canvas = doc?.getElementById("document-canvas");
      if (canvas instanceof HTMLElement) canvas.focus();
    }
    window.setTimeout(() => {
      map?._docLayer?._updateCursorAndOverlay?.();
      map?._textInput?.showCursor?.();
    }, 0);
  } catch {
    // Cross-origin / not-ready iframe: ignore. The next ready callback will retry.
  }
}
