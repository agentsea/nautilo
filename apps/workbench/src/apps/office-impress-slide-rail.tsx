// Wave C, D362 — Impress slide rail (vertical thumbnail column).
//
// Pure, prop-driven React component. UI logic only — no engine/session code,
// no surface wiring. The host surface passes slide state via props and wires
// callbacks to Collabora socket / UNO verbs separately.

import {
  Copy,
  FilePlus,
  MoveDown,
  MoveUp,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { toolbarButtonClass } from "./office-ribbon";

export interface ImpressSlideRailProps {
  ready: boolean;
  slides: ReadonlyArray<{ index: number; preview?: string }>;
  activeIndex: number;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function slideCardClass(active: boolean): string {
  const base =
    "flex w-full flex-col gap-1 rounded-md border p-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  if (active) {
    return `${base} border-primary bg-primary-muted ring-1 ring-primary/30`;
  }
  return `${base} border-border/60 bg-background-element hover:border-border hover:bg-muted/40`;
}

function RailToolbarButton({
  title,
  Icon,
  ready,
  onClick,
}: {
  title: string;
  Icon: LucideIcon;
  ready: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={!ready}
      className={`flex items-center justify-center ${toolbarButtonClass()}`}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

export function ImpressSlideRail({
  ready,
  slides,
  activeIndex,
  onSelect,
  onAdd,
  onDuplicate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: ImpressSlideRailProps): React.JSX.Element {
  return (
    <aside
      aria-label="Slides"
      aria-disabled={!ready}
      className="flex h-full w-36 shrink-0 flex-col border-r border-border/60 bg-background"
    >
      <div
        role="toolbar"
        aria-label="Slide actions"
        className="grid shrink-0 grid-cols-5 gap-0.5 border-b border-border/60 px-1 py-1"
      >
        <RailToolbarButton title="New slide" Icon={FilePlus} ready={ready} onClick={onAdd} />
        <RailToolbarButton title="Duplicate slide" Icon={Copy} ready={ready} onClick={onDuplicate} />
        <RailToolbarButton title="Delete slide" Icon={Trash2} ready={ready} onClick={onDelete} />
        <RailToolbarButton title="Move slide up" Icon={MoveUp} ready={ready} onClick={onMoveUp} />
        <RailToolbarButton title="Move slide down" Icon={MoveDown} ready={ready} onClick={onMoveDown} />
      </div>

      <div
        role="list"
        aria-label="Slide thumbnails"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {slides.map(({ index, preview }) => {
          const active = index === activeIndex;
          const slideNumber = index + 1;
          return (
            <button
              key={index}
              type="button"
              role="listitem"
              aria-label={`Slide ${slideNumber}`}
              aria-current={active ? "true" : undefined}
              disabled={!ready}
              className={slideCardClass(active)}
              onClick={() => onSelect(index)}
            >
              <span className="select-none text-[10px] font-semibold tabular-nums text-foreground-muted">
                {slideNumber}
              </span>
              {preview ? (
                <img
                  src={preview}
                  alt=""
                  className="aspect-[4/3] w-full rounded border border-border/40 bg-background object-contain"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="aspect-[4/3] w-full rounded border border-border/40 bg-muted/50"
                />
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
