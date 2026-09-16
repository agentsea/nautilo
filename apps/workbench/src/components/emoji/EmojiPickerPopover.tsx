import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import { createWorkbenchPortal as createPortal } from "../workbench-portals";
import { EmojiPicker } from "frimousse";

/** Popover layout — keep in sync with EmojiPicker.Root Tailwind classes. */
const PICKER_WIDTH_REM = 20;
const PICKER_HEIGHT_REM = 22;
const VIEWPORT_MARGIN_PX = 8;
const GAP_ABOVE_BUTTON_PX = 8;

export type ComposerEmojiPopoverViewport = {
  innerWidth: number;
  innerHeight: number;
  rootFontPx: number;
};

function readViewport(): ComposerEmojiPopoverViewport {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    rootFontPx:
      parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16,
  };
}

/** Viewport-aware fixed position for the portal popover (exported for unit tests). */
export function computeComposerEmojiPopoverPosition(
  rect: DOMRect,
  viewport: ComposerEmojiPopoverViewport = readViewport(),
): {
  left: number;
  bottom: number;
} {
  const pickerWidth = PICKER_WIDTH_REM * viewport.rootFontPx;
  const minLeft = VIEWPORT_MARGIN_PX;
  const maxLeft = viewport.innerWidth - pickerWidth - VIEWPORT_MARGIN_PX;

  // Default: anchor popover bottom-left to the button; flip to right-align when
  // the picker would extend past the viewport (e.g. right-docked reader rail).
  let left = rect.left;
  if (left + pickerWidth > viewport.innerWidth - VIEWPORT_MARGIN_PX) {
    left = rect.right - pickerWidth;
  }
  left = Math.max(minLeft, Math.min(left, maxLeft));

  const bottom = viewport.innerHeight - rect.top + GAP_ABOVE_BUTTON_PX;
  return { left, bottom };
}

/** Either anchor the popover above (`bottom`) or below (`top`) the trigger. */
export type EmojiPopoverPosition =
  | { left: number; top: number }
  | { left: number; bottom: number };

/**
 * General viewport-aware position for the picker anchored to ANY trigger
 * (composer at the bottom, a reaction button high in the thread, a
 * right-docked rail). Clamps horizontally and flips vertically so the
 * 22rem-tall picker stays on-screen instead of overflowing the top.
 * Exported for unit tests.
 */
export function computeEmojiPopoverPosition(
  rect: DOMRect,
  viewport: ComposerEmojiPopoverViewport = readViewport(),
): EmojiPopoverPosition {
  const pickerWidth = PICKER_WIDTH_REM * viewport.rootFontPx;
  const pickerHeight = PICKER_HEIGHT_REM * viewport.rootFontPx;
  const minLeft = VIEWPORT_MARGIN_PX;
  const maxLeft = viewport.innerWidth - pickerWidth - VIEWPORT_MARGIN_PX;

  // Horizontal: left-align to the trigger; flip to right-align when the picker
  // would overflow the right edge; clamp into the viewport margins.
  let left = rect.left;
  if (left + pickerWidth > viewport.innerWidth - VIEWPORT_MARGIN_PX) {
    left = rect.right - pickerWidth;
  }
  left = Math.max(minLeft, Math.min(left, maxLeft));

  // Vertical: open upward when there's room above (or more room above than
  // below); otherwise open downward. Keeps the composer (anchored at the
  // bottom) opening up while a high-in-thread reaction trigger opens down.
  const spaceAbove = rect.top - VIEWPORT_MARGIN_PX;
  const spaceBelow = viewport.innerHeight - rect.bottom - VIEWPORT_MARGIN_PX;
  const openUp = spaceAbove >= pickerHeight || spaceAbove >= spaceBelow;
  if (openUp) {
    return { left, bottom: viewport.innerHeight - rect.top + GAP_ABOVE_BUTTON_PX };
  }
  return { left, top: rect.bottom + GAP_ABOVE_BUTTON_PX };
}

export type EmojiPickerPopoverProps = {
  readonly open: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly onSelect: (emoji: string) => void;
  readonly onClose: () => void;
  readonly popoverTestId?: string;
};

/**
 * Portal-mounted frimousse emoji picker popover. Positions above `anchorRef`,
 * repositions on scroll/resize, closes on Escape or outside pointer-down.
 */
export function EmojiPickerPopover({
  open,
  anchorRef,
  onSelect,
  onClose,
  popoverTestId = "emoji-picker-popover",
}: EmojiPickerPopoverProps): ReactElement | null {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<EmojiPopoverPosition | null>(null);

  const reposition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos(computeEmojiPopoverPosition(rect));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onScrollOrResize = () => reposition();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, reposition, onClose, anchorRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        left: pos.left,
        ...("top" in pos ? { top: pos.top } : { bottom: pos.bottom }),
        zIndex: 60,
      }}
      data-testid={popoverTestId}
    >
      <EmojiPicker.Root
        onEmojiSelect={({ emoji }) => {
          onSelect(emoji);
          onClose();
        }}
        className="flex h-[22rem] w-[20rem] flex-col rounded-lg border border-border-strong bg-background-panel shadow-xl"
      >
        <EmojiPicker.Search
          autoFocus
          placeholder="Search emoji…"
          className="m-2 shrink-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-foreground-muted focus:border-primary"
        />
        <EmojiPicker.Viewport className="relative flex-1 overflow-y-auto px-1 pb-2">
          <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-xs text-foreground-muted">
            Loading…
          </EmojiPicker.Loading>
          <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-xs text-foreground-muted">
            No emoji found.
          </EmojiPicker.Empty>
          <EmojiPicker.List
            className="select-none"
            components={{
              CategoryHeader: ({ category, ...props }) => (
                <div
                  {...props}
                  className="bg-background-panel px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground-muted"
                >
                  {category.label}
                </div>
              ),
              Emoji: ({ emoji, ...props }) => (
                <button
                  {...props}
                  className="flex h-8 w-8 items-center justify-center rounded text-xl data-[active]:bg-background-element"
                >
                  {emoji.emoji}
                </button>
              ),
            }}
          />
        </EmojiPicker.Viewport>
      </EmojiPicker.Root>
    </div>,
    document.body,
  );
}
