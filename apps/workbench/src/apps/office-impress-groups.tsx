// Wave C, D362 — Impress-specific ribbon groups (Slide / Insert / Present).
//
// Pure, reusable React components. UI logic only — no engine/session code,
// no surface wiring. The host surface injects a `RibbonActions` handle so
// these groups stay decoupled from the Collabora map / socket plumbing.
//
// Verify UNO verbs and argument shapes against the owned Office engine
// source before adding actions. See docs/office-engines/README.md.

import { useRef, useState } from "react";
import {
  BarChart3,
  LayoutTemplate,
  Play,
  Shapes,
  Squircle,
  Square,
  Circle,
  StickyNote,
  Type,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { AnchoredPopover, RibbonGroup, toolbarButtonClass } from "./office-ribbon";
import type { RibbonActions } from "./office-ribbon";

/** Shared toolbar button for an icon-driven Impress verb. */
function ImpressIconButton({
  title,
  Icon,
  actions,
  active,
  onClick,
}: {
  title: string;
  Icon: LucideIcon;
  actions: RibbonActions;
  active?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const isOn = active ?? false;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={isOn}
      disabled={!actions.ready}
      className={toolbarButtonClass(isOn)}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/**
 * §2 / build-sheet rows: Insert slide (FF), Duplicate (FF), Delete (FF),
 * Move up / Move down (FF). All `actions.sendUno` — no args. Collabora
 * inserts/duplicates relative to the current slide; no positional arg is
 * wired here (that's host-surface context, not available to a pure group).
 *
 * Optional layout picker uses AutoLayout ids from build-sheet §2 /
 * Collabora `Definitions.Menu.ts:2196-2199` layoutMap.
 */
const IMPRESS_LAYOUT_CHOICES: ReadonlyArray<{ id: number; label: string }> = [
  { id: 20, label: "Blank" },
  { id: 0, label: "Title Slide" },
  { id: 1, label: "Title, Content" },
  // Collabora `Definitions.Menu.ts:2201` — not enumerated in build-sheet §2 ellipsis.
  { id: 19, label: "Title Only" },
];

/** §2 — layout picker: `onApplyLayout(layoutId)` with grounded AutoLayout ids. */
function ImpressLayoutMenu({
  actions,
  onApplyLayout,
}: {
  actions: RibbonActions;
  onApplyLayout: (layoutId: number) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Slide layout"
        aria-label="Slide layout"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={!actions.ready}
        className={toolbarButtonClass(open)}
        onClick={() => setOpen((v) => !v)}
      >
        <LayoutTemplate className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="grid grid-cols-2 gap-1">
          {IMPRESS_LAYOUT_CHOICES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              disabled={!actions.ready}
              className="rounded border border-border/60 px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted disabled:opacity-40"
              onClick={() => {
                onApplyLayout(id);
                setOpen(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}

export function ImpressSlideGroup({
  actions,
  onApplyLayout,
}: {
  actions: RibbonActions;
  onApplyLayout?: (layoutId: number) => void;
}): React.JSX.Element {
  // The 5 slide-management verbs (New / Duplicate / Delete / Move up / Move
  // down) live ONLY on the slide rail (`office-impress-slide-rail.tsx`) — they
  // used to be duplicated here too. Slide-background color is PUNTED to Wave J
  // (the JSDialog `SlideBackgroundPanel` sidebar path): bare `.uno:FillPageColor`
  // is a confirmed no-op in coolwsd 26.04 (verified live 2026-07-06 — native
  // blank Impress + imported .pptx, both `.Color` and `.FillColor` arg keys,
  // raw sendUnoCommand and ribbon swatch: no visible change, no error). So this
  // group is now just the layout picker (label: "Layout").
  return (
    <RibbonGroup label="Layout">
      {onApplyLayout ? <ImpressLayoutMenu actions={actions} onApplyLayout={onApplyLayout} /> : null}
    </RibbonGroup>
  );
}

/**
 * §2 / build-sheet rows: Insert text box (`.uno:DrawText`, FF mode toggle)
 * and Insert shape (`.uno:BasicShapes.<shape>`, FF mode toggle). A small
 * shape dropdown offers rectangle / ellipse / round-rectangle.
 */
export function ImpressInsertGroup({ actions }: { actions: RibbonActions }): React.JSX.Element {
  // NOTE(wave-c): FF enters insert mode; user draws on canvas. Agent-driven placement is out of scope (build-sheet §4.4).
  return (
    <RibbonGroup label="Insert">
      <ImpressIconButton
        title="Text box"
        Icon={Type}
        actions={actions}
        onClick={() => actions.sendUno(".uno:DrawText")}
      />
      <ImpressShapeMenu actions={actions} />
      {/* Requests a default chart on the current slide and enters engine chart
          editing. Chart configuration uses the engine dialog. Interactive
          acceptance must verify the visible result and exit behavior. */}
      <ImpressIconButton
        title="Insert chart"
        Icon={BarChart3}
        actions={actions}
        onClick={() => actions.sendUno(".uno:InsertObjectChart")}
      />
    </RibbonGroup>
  );
}

/** §2 — shape dropdown: rectangle / ellipse / round-rectangle via `.uno:BasicShapes.<shape>`. */
function ImpressShapeMenu({ actions }: { actions: RibbonActions }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const shapes: ReadonlyArray<{ label: string; Icon: LucideIcon; command: string }> = [
    { label: "Rectangle", Icon: Square, command: ".uno:BasicShapes.rectangle" },
    { label: "Ellipse", Icon: Circle, command: ".uno:BasicShapes.ellipse" },
    { label: "Round rectangle", Icon: Squircle, command: ".uno:BasicShapes.round-rectangle" },
  ];
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Insert shape"
        aria-label="Insert shape"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={!actions.ready}
        className={toolbarButtonClass(open)}
        onClick={() => setOpen((v) => !v)}
      >
        <Shapes className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="flex flex-col gap-0.5">
          {shapes.map(({ label, Icon, command }) => (
            <button
              key={command}
              type="button"
              title={label}
              aria-label={label}
              disabled={!actions.ready}
              className="flex items-center gap-2 rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted disabled:opacity-40"
              onClick={() => {
                actions.sendUno(command);
                setOpen(false);
              }}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * §2 / build-sheet row: Start presentation.
 *
 * D362 §5a — replaced `.uno:Presentation` (a LibreOffice *core* slot,
 * `SID_PRESENTATION`, that runs the in-core `ShowWindow` slideshow with NO
 * browser-side End Show / Escape) with Collabora's browser-side canvas
 * slideshow, triggered by the
 * `fullscreen-presentation` action id (the same path Collabora's own menubar
 * uses, `Control.Menubar.ts:2337`). `docdispatcher.ts:511-517` maps the action
 * to `app.map.fire('newfullscreen')` → `SlideShowPresenter._onStart`
 * (`SlideShowPresenter.ts:172, 1159-1171`) → the canvas slideshow with the
 * End Show button + Escape handler. The iframe is now `allowFullScreen`
 * (see `office-doc-surface.tsx`) so `requestFullscreen()` succeeds →
 * browser-Escape exits cleanly.
 *
 * LIVE-VERIFY PENDING: see investigation §7.
 */
export function ImpressPresentGroup({ actions }: { actions: RibbonActions }): React.JSX.Element {
  // NOTE(wave-c): verify embed/fullscreen behavior live (build-sheet §4.6).
  return (
    <RibbonGroup label="Present">
      <ImpressIconButton
        title="Start presentation"
        Icon={Play}
        actions={actions}
        onClick={() => actions.dispatchClientAction("fullscreen-presentation")}
      />
      <ImpressIconButton
        title="Notes view"
        Icon={StickyNote}
        actions={actions}
        active={actions.isActive("NotesMode")}
        onClick={() => actions.sendUno(".uno:NotesMode")}
      />
    </RibbonGroup>
  );
}
