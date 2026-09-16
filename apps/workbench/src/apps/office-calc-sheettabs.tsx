// Wave C, D362 — Calc sheet-tab bar.
//
// Pure, prop-driven React component. UI logic only — no engine/session code,
// no surface wiring. The host surface passes sheet state via props and wires
// callbacks to Collabora socket / UNO verbs separately.
//
// Verify Insert / Remove / Name / setclientpart against the owned Office
// engine source. See docs/office-engines/README.md.

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { toolbarButtonClass } from "./office-ribbon";

export interface CalcSheetTabsProps {
  ready: boolean;
  sheets: ReadonlyArray<{ name: string; index: number }>;
  activeIndex: number;
  onSwitch: (index: number) => void;
  onAdd: () => void;
  onDelete: (index: number) => void;
  onRename: (index: number, name: string) => void;
}

function sheetTabClass(active: boolean): string {
  const base =
    "flex shrink-0 items-center rounded-t px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40";
  if (active) {
    return `${base} border-b-2 border-primary bg-primary-muted font-medium text-primary`;
  }
  return `${base} text-foreground-muted hover:bg-muted/50 hover:text-foreground`;
}

export function CalcSheetTabs({
  ready,
  sheets,
  activeIndex,
  onSwitch,
  onAdd,
  onDelete,
  onRename,
}: CalcSheetTabsProps): React.JSX.Element {
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const isRenamingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const canDelete = sheets.length > 1;

  useEffect(() => {
    if (renamingIndex !== null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingIndex]);

  const startRename = (index: number, currentName: string): void => {
    if (!ready) return;
    setRenamingIndex(index);
    setDraftName(currentName);
    isRenamingRef.current = true;
  };

  const cancelRename = (): void => {
    isRenamingRef.current = false;
    setRenamingIndex(null);
    setDraftName("");
  };

  const commitRename = (index: number, originalName: string): void => {
    isRenamingRef.current = false;
    setRenamingIndex(null);
    const trimmed = draftName.trim();
    if (trimmed !== "" && trimmed !== originalName) {
      onRename(index, trimmed);
    }
    setDraftName("");
  };

  return (
    <div
      role="tablist"
      aria-label="Sheet tabs"
      aria-disabled={!ready}
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto border-t border-border/60 bg-background px-2 py-1"
    >
      {sheets.map(({ name, index }) => {
        const active = index === activeIndex;
        const renaming = renamingIndex === index;

        if (renaming) {
          return (
            <div key={index} className="flex shrink-0 items-center py-0.5">
              <input
                ref={renameInputRef}
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(index, name);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => {
                  if (isRenamingRef.current) commitRename(index, name);
                }}
                className="min-w-[4rem] max-w-[12rem] rounded border border-border-interactive bg-background-element px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-border-interactive"
                aria-label={`Rename sheet ${name}`}
              />
            </div>
          );
        }

        return (
          <div key={index} className="group/tab flex shrink-0 items-center">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              aria-label={`Sheet ${name}`}
              title={name}
              disabled={!ready}
              className={sheetTabClass(active)}
              onClick={() => onSwitch(index)}
              onDoubleClick={(e) => {
                e.preventDefault();
                startRename(index, name);
              }}
            >
              <span className="max-w-[10rem] truncate">{name}</span>
            </button>
            {canDelete ? (
              <button
                type="button"
                aria-label={`Delete sheet ${name}`}
                title={`Delete sheet ${name}`}
                disabled={!ready}
                className="-ml-1 rounded p-0.5 text-foreground-muted opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(index);
                }}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}

      <button
        type="button"
        aria-label="Add sheet"
        title="Add sheet"
        disabled={!ready}
        className={`${toolbarButtonClass()} shrink-0`}
        onClick={() => onAdd()}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
