import { useCallback, useRef, useState } from "react";
import type { PointerEvent, ReactElement } from "react";
import { SmilePlus } from "lucide-react";
import { EmojiPickerPopover } from "../../../../components/emoji/EmojiPickerPopover";

const LONG_PRESS_MS = 400;

export type MessageReactTriggerProps = {
  readonly onReact: (emoji: string) => void;
  readonly disabled?: boolean;
  /** Defaults preserve the established add-reaction wording outside D527. */
  readonly accessibleLabel?: string;
  readonly title?: string;
};

/**
 * D312 — per-message "add reaction" affordance (presentational).
 *
 * Opens the shared emoji picker on click (desktop) or ~400ms long-press
 * (touch). Selecting an emoji calls `onReact` and closes the popover.
 */
export function MessageReactTrigger({
  onReact,
  disabled = false,
  accessibleLabel = "Add reaction",
  title = accessibleLabel,
}: MessageReactTriggerProps): ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOpenedRef = useRef(false);
  const [open, setOpen] = useState(false);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = (_e: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    longPressOpenedRef.current = false;
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressOpenedRef.current = true;
      setOpen(true);
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = () => {
    clearLongPressTimer();
  };

  const handlePointerCancel = () => {
    clearLongPressTimer();
  };

  const handleClick = () => {
    if (disabled) return;
    if (longPressOpenedRef.current) {
      longPressOpenedRef.current = false;
      return;
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        title={title}
        aria-label={accessibleLabel}
        aria-expanded={open}
        data-testid="message-react-trigger"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted hover:bg-background-element disabled:opacity-40"
      >
        <SmilePlus aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
      </button>

      <EmojiPickerPopover
        open={open}
        anchorRef={buttonRef}
        onSelect={onReact}
        onClose={() => setOpen(false)}
        popoverTestId="message-react-popover"
      />
    </>
  );
}
