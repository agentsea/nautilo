import type { ReactElement } from "react";

/**
 * D323 — bottom-center status pill for a model fallback hop
 * ("X timed out — trying Y").
 *
 * Presentational only: the SET/CLEAR lifecycle (and the turn-scoped
 * auto-expiry timer) lives in `NautiloRuntimeProvider`. This component
 * owns the two D323 guarantees a user can see and act on:
 *   - it is NOT `pointer-events-none` — the whole pill is a Dismiss button;
 *   - clicking it invokes `onDismiss` so the notice can be cleared by hand
 *     instead of waiting for a turn-terminal event.
 *
 * Extracted from `nautilo-runtime.tsx` so the dismiss affordance is unit-
 * testable without importing the full runtime provider graph.
 */
export function ModelFallbackStatusNotice({
  line,
  onDismiss,
}: {
  line: string;
  onDismiss: () => void;
}): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="model-fallback-status"
      className="fixed bottom-28 left-1/2 z-50 max-w-md -translate-x-1/2 px-4"
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="flex items-center gap-2 rounded-full border border-border/60 bg-background-muted/95 px-3 py-1.5 text-[11px] text-foreground-muted shadow-sm backdrop-blur-sm transition-opacity hover:opacity-80"
      >
        <span>{line}</span>
        <span aria-hidden="true" className="text-foreground-muted/70">
          ✕
        </span>
      </button>
    </div>
  );
}
