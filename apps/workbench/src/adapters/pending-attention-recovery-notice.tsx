import type { ReactElement } from "react";

/** Small, non-authoritative retry affordance for a failed checkpoint preview read. */
export function PendingAttentionRecoveryNotice({
  onRetry,
}: Readonly<{
  onRetry?: (() => void) | undefined;
}>): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pending-attention-recovery-status"
      className="fixed bottom-28 left-1/2 z-50 max-w-md -translate-x-1/2 px-4"
    >
      <div className="flex items-center gap-2 rounded-full border border-border/60 bg-background-muted/95 px-3 py-1.5 text-[11px] text-foreground-muted shadow-sm backdrop-blur-sm">
        <span>{onRetry === undefined
          ? "Update Nautilo Desktop to restore pending approvals."
          : "Couldn’t restore a pending approval."}</span>
        {onRetry === undefined ? null : (
          <button
            type="button"
            onClick={onRetry}
            className="font-medium text-foreground underline underline-offset-2 hover:opacity-80"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
