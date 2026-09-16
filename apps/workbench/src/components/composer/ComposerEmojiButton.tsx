import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { Smile } from "lucide-react";
import { EmojiPickerPopover } from "../emoji/EmojiPickerPopover";

export {
  computeComposerEmojiPopoverPosition,
  type ComposerEmojiPopoverViewport,
} from "../emoji/EmojiPickerPopover";

/**
 * D278 §9.1 / D212 Tier 1 — composer emoji button + portal picker popover.
 *
 * `🙂` in the composer opens a searchable emoji picker (frimousse: unstyled,
 * composable, auto-updating Unicode set via Emojibase, cached locally). The
 * popover renders in a portal positioned above the button so it is never
 * clipped by the composer's container. Selecting an emoji calls `onSelect`
 * (which inserts it into the composer) and closes the popover.
 */
export function ComposerEmojiButton({
  onSelect,
  disabled = false,
}: {
  readonly onSelect: (emoji: string) => void;
  readonly disabled?: boolean;
}): ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="Emoji"
        aria-label="Insert emoji"
        aria-expanded={open}
        data-testid="composer-emoji-button"
        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted hover:bg-background-element disabled:opacity-40"
      >
        <Smile aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
      </button>

      <EmojiPickerPopover
        open={open}
        anchorRef={buttonRef}
        onSelect={onSelect}
        onClose={() => setOpen(false)}
        popoverTestId="composer-emoji-popover"
      />
    </>
  );
}
