import type { ReactElement } from "react";

/** Stable room-routed notice while a foreground turn waits for crypto authority. */
export function ForegroundContextStatusNotice({ line }: { line: string }): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="foreground-context-status"
      className="fixed bottom-28 left-1/2 z-50 max-w-md -translate-x-1/2 px-4"
    >
      <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background-muted/95 px-3 py-1.5 text-[11px] text-foreground-muted shadow-sm backdrop-blur-sm">
        <span className="inline-block size-2 animate-pulse rounded-full bg-current" aria-hidden="true" />
        <span>{line}</span>
      </div>
    </div>
  );
}
