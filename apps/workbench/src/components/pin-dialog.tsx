import { useState, useRef, useEffect, useCallback } from "react";

export interface PinDialogProps {
  onSubmit: (pin: string) => void;
  onCancel: () => void;
  error?: string;
  title?: string;
  prompt?: string;
  submitting?: boolean;
  submittingLabel?: string;
}

export function PinDialog({
  onSubmit,
  onCancel,
  error,
  title = "Verify Identity",
  prompt = "Enter your PIN to confirm who you are",
  submitting = false,
  submittingLabel = "Checking…",
}: PinDialogProps) {
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (submitting) {
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && pin.length >= 6) {
        e.preventDefault();
        onSubmit(pin);
      }
    },
    [pin, onSubmit, onCancel, submitting],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, "").slice(0, 8);
    setPin(val);
  }, []);

  const canSubmit = pin.length >= 6 && !submitting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
      aria-busy={submitting}
    >
      <div className="w-full max-w-sm rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-primary">{title}</h2>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded p-1 text-foreground-muted hover:text-foreground"
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>

        <p className="mt-3 text-sm text-foreground-muted">{prompt}</p>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          onChange={handleChange}
          disabled={submitting}
          placeholder="••••••"
          className="mt-4 w-full rounded-md border border-border bg-background-element px-3 py-2 text-center text-lg tracking-[0.3em] text-foreground placeholder:text-foreground-disabled focus:border-border-interactive focus:outline-none"
          autoComplete="off"
        />

        {error && (
          <p className="mt-2 text-sm text-error">{error}</p>
        )}

        <p className="mt-2 text-xs text-foreground-dim">
          {submitting ? submittingLabel : pin.length < 6 ? "Type 6–8 digits" : "Press Enter to verify"}
        </p>

        <div className="mt-5 flex gap-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element"
          >
            Cancel
          </button>
          <button
            onClick={() => canSubmit && onSubmit(pin)}
            disabled={!canSubmit}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" /> : null}
            {submitting ? submittingLabel : "Verify"}
          </button>
        </div>
      </div>
    </div>
  );
}
