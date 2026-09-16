// Wave C, D362 — Calc-specific ribbon groups (Number / Cells / Data).
//
// Pure, reusable React components. UI logic only — no engine/session code,
// no surface wiring. The host surface injects a `RibbonActions` handle so
// these groups stay decoupled from the Collabora map / socket plumbing.
//
// Verify UNO verbs and argument shapes against the owned Office engine
// source before adding actions. See docs/office-engines/README.md.

import { useRef, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  Eraser,
  Frame,
  Grid2X2,
  Calendar,
  DollarSign,
  Hash,
  ListFilter,
  Percent,
  Sigma,
  Snowflake,
  TableCellsMerge,
  WrapText,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { AnchoredPopover, RibbonGroup, toolbarButtonClass } from "./office-ribbon";
import type { RibbonActions } from "./office-ribbon";

/** Shared toolbar button for an icon-driven Calc verb. */
function CalcIconButton({
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

/** Shared toolbar button for a text-label Calc verb (decimals ±). */
function CalcTextButton({
  title,
  label,
  actions,
  onClick,
}: {
  title: string;
  label: string;
  actions: RibbonActions;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={!actions.ready}
      className={toolbarButtonClass()}
      onClick={onClick}
    >
      <span className="block min-w-[1.75rem] text-center text-[10px] font-semibold tabular-nums">
        {label}
      </span>
    </button>
  );
}

/**
 * §1 / build-sheet rows: Number format → General / Number / Currency /
 * Percent / Date + Decimals ±. All fire-and-forget `sendUno`. Currency,
 * Percent, Date are STATE — reflect via `isActive`.
 */
export function CalcNumberGroup({ actions }: { actions: RibbonActions }): React.JSX.Element {
  return (
    <RibbonGroup label="Number">
      <CalcIconButton
        title="Number format: General"
        Icon={Hash}
        actions={actions}
        onClick={() => actions.sendUno(".uno:NumberFormatStandard")}
      />
      <CalcIconButton
        title="Number format: Number"
        Icon={Hash}
        actions={actions}
        onClick={() => actions.sendUno(".uno:NumberFormatDecimal")}
      />
      <CalcIconButton
        title="Number format: Currency"
        Icon={DollarSign}
        actions={actions}
        active={actions.isActive("NumberFormatCurrency")}
        onClick={() => actions.sendUno(".uno:NumberFormatCurrency")}
      />
      <CalcIconButton
        title="Number format: Percent"
        Icon={Percent}
        actions={actions}
        active={actions.isActive("NumberFormatPercent")}
        onClick={() => actions.sendUno(".uno:NumberFormatPercent")}
      />
      <CalcIconButton
        title="Number format: Date"
        Icon={Calendar}
        actions={actions}
        active={actions.isActive("NumberFormatDate")}
        onClick={() => actions.sendUno(".uno:NumberFormatDate")}
      />
      <CalcTextButton
        title="Increase decimals"
        label=".00→"
        actions={actions}
        onClick={() => actions.sendUno(".uno:NumberFormatIncDecimals")}
      />
      <CalcTextButton
        title="Decrease decimals"
        label=".0←"
        actions={actions}
        onClick={() => actions.sendUno(".uno:NumberFormatDecDecimals")}
      />
    </RibbonGroup>
  );
}

/**
 * §1 / build-sheet rows: Merge cells, Wrap text, Freeze panes — all FF toggles
 * with STATE. Borders are wired as a preset popover (Outline / All / None)
 * sending `.uno:SetBorderStyle` with the 6-BorderLine2 struct arg shape
 * grounded in `EXTERNAL/collabora-online-source/browser/src/control/
 * Control.Toolbar.js:39-152` (`getBorderStyleUNOCommand`) — the same preset
 * builder the human Calc border-toolbar dropdown fires. Arbitrary per-side
 * border specs (color/width per side) remain UNGROUNDED and out of scope
 * (build-sheet §4.2); only the three presets are exposed. The arg-shape
 * mirror is shared verbatim with the agent-side `format_range --borders`
 * path (`packages/agent/src/tools/office/office.ts:3821` `borderPresetArgs`).
 */
export function CalcCellsGroup({ actions }: { actions: RibbonActions }): React.JSX.Element {
  return (
    <RibbonGroup label="Cells">
      <CalcIconButton
        title="Merge cells"
        Icon={TableCellsMerge}
        actions={actions}
        active={actions.isActive("ToggleMergeCells")}
        onClick={() => actions.sendUno(".uno:ToggleMergeCells")}
      />
      <CalcIconButton
        title="Wrap text"
        Icon={WrapText}
        actions={actions}
        active={actions.isActive("WrapText")}
        onClick={() => actions.sendUno(".uno:WrapText")}
      />
      <CalcIconButton
        title="Freeze panes"
        Icon={Snowflake}
        actions={actions}
        active={actions.isActive("FreezePanes")}
        onClick={() => actions.sendUno(".uno:FreezePanes")}
      />
      <CalcBordersMenu actions={actions} />
    </RibbonGroup>
  );
}

/** §4.2 — Calc borders preset popover: Outline / All / None. */
const CALC_BORDER_PRESETS: ReadonlyArray<{
  id: "outline" | "all" | "none";
  label: string;
  Icon: LucideIcon;
}> = [
  { id: "outline", label: "Outline", Icon: Frame },
  { id: "all", label: "All borders", Icon: Grid2X2 },
  { id: "none", label: "No borders", Icon: Eraser },
];

/**
 * §4.2 — borders preset arg builder. Mirrors `borderPresetArgs` in
 * `packages/agent/src/tools/office/office.ts:3821` (the agent-side
 * `format_range --borders` path), which is itself grounded in Collabora's
 * `getBorderStyleUNOCommand` (`Control.Toolbar.js:39-152`). The 6
 * funParams order is [top, bottom, left, right, horiz, vert]
 * (SvxBoxInfoItemValidFlags 0x01..0x20); `_setBorders(left, right, bottom,
 * top, horiz, vert, color)` permutes to BorderLine2 order:
 *   - OuterBorder[] = [left, right, bottom, top] BorderLine2 structs
 *     (OuterLineWidth = the side's width), followed by 5 `long` zeros.
 *   - InnerBorder[] = [horiz, vert] BorderLine2 structs, followed by
 *     `short` 0, `short` valid flags, `long` 0.
 * Width 1 = "on", 0 = "off"; color 0 = black (preset has no color arg).
 * When no flags are set, the source flips `valid` to 0x7f (clear-all
 * sentinel — lines 59-62).
 */
function calcBorderPresetArgs(preset: "outline" | "all" | "none"): Record<
  string,
  { type: string; value: unknown }
> {
  const on = preset === "outline" || preset === "all" ? 1 : 0;
  const inner = preset === "all" ? 1 : 0;
  const left = on;
  const right = on;
  const bottom = on;
  const top = on;
  const horiz = inner;
  const vert = inner;
  // SvxBoxInfoItemValidFlags: top=0x01, bottom=0x02, left=0x04, right=0x08,
  // horiz=0x10, vert=0x20. Source flips valid=0 → 0x7f (clear-all).
  let valid = 0;
  if (top) valid |= 0x01;
  if (bottom) valid |= 0x02;
  if (left) valid |= 0x04;
  if (right) valid |= 0x08;
  if (horiz) valid |= 0x10;
  if (vert) valid |= 0x20;
  if (valid === 0) valid = 0x7f;
  const borderLine = (outerLineWidth: number) => ({
    type: "com.sun.star.table.BorderLine2",
    value: {
      Color: { type: "com.sun.star.util.Color", value: 0 },
      InnerLineWidth: { type: "short", value: 0 },
      OuterLineWidth: { type: "short", value: outerLineWidth },
      LineDistance: { type: "short", value: 0 },
      LineStyle: { type: "short", value: 0 },
      LineWidth: { type: "unsigned long", value: 0 },
    },
  });
  return {
    OuterBorder: {
      type: "[]any",
      value: [
        borderLine(left),
        borderLine(right),
        borderLine(bottom),
        borderLine(top),
        { type: "long", value: 0 },
        { type: "long", value: 0 },
        { type: "long", value: 0 },
        { type: "long", value: 0 },
        { type: "long", value: 0 },
      ],
    },
    InnerBorder: {
      type: "[]any",
      value: [
        borderLine(horiz),
        borderLine(vert),
        { type: "short", value: 0 },
        { type: "short", value: valid },
        { type: "long", value: 0 },
      ],
    },
  };
}

function CalcBordersMenu({ actions }: { actions: RibbonActions }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Borders"
        aria-label="Borders"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={!actions.ready}
        className={toolbarButtonClass(open)}
        onClick={() => setOpen((v) => !v)}
      >
        <Grid2X2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <AnchoredPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className="flex flex-col gap-0.5">
          {CALC_BORDER_PRESETS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              disabled={!actions.ready}
              className="flex items-center gap-2 rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted disabled:opacity-40"
              onClick={() => {
                actions.sendUnoArgs(".uno:SetBorderStyle", calcBorderPresetArgs(id));
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
 * §1 / build-sheet rows: Sort ascending / descending (FF), AutoFilter
 * (FF + STATE), Insert function (FF — opens the engine-side Function
 * Wizard as an acceptable interim; a Nautilo function picker emitting
 * `.uno:EnterString` with the composed formula is the long-term path),
 * Insert chart (near-FF per phase-4 §4.4 — chart CONFIG stays Wave J.5).
 */
export function CalcDataGroup({ actions }: { actions: RibbonActions }): React.JSX.Element {
  return (
    <RibbonGroup label="Data">
      <CalcIconButton
        title="Sort ascending"
        Icon={ArrowUpAZ}
        actions={actions}
        onClick={() => actions.sendUno(".uno:SortAscending")}
      />
      <CalcIconButton
        title="Sort descending"
        Icon={ArrowDownAZ}
        actions={actions}
        onClick={() => actions.sendUno(".uno:SortDescending")}
      />
      <CalcIconButton
        title="AutoFilter"
        Icon={ListFilter}
        actions={actions}
        active={actions.isActive("DataFilterAutoFilter")}
        onClick={() => actions.sendUno(".uno:DataFilterAutoFilter")}
      />
      {/* TODO(wave-c): replace engine Function Wizard with a Nautilo function picker (build-sheet §1) */}
      <CalcIconButton
        title="Insert function"
        Icon={Sigma}
        actions={actions}
        onClick={() => actions.sendUno(".uno:FunctionDialog")}
      />
      {/* Requests a default chart from the current selection. Chart configuration
          uses the engine dialog; ColHeaders/RowHeaders/RangeList are not wired
          here. Interactive acceptance must verify whether a dialog appears. */}
      <CalcIconButton
        title="Insert chart"
        Icon={BarChart3}
        actions={actions}
        onClick={() => actions.sendUno(".uno:InsertObjectChart")}
      />
    </RibbonGroup>
  );
}
