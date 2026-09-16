import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface NewFileDialogProps {
  title: string;
  description: string;
  initialName?: string;
  validateName?: (name: string) => string | null;
  errorMessage?: string | null;
  children?: ReactNode;
  onCreate: (name: string) => void;
  onCancel: () => void;
  error?: string | null;
  busy?: boolean;
}

export function NewFileDialog({
  title,
  description,
  initialName = "untitled.md",
  validateName,
  errorMessage,
  children,
  onCreate,
  onCancel,
  error: externalError = null,
  busy = false,
}: NewFileDialogProps) {
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = useCallback(() => {
    if (busy) return;
    const name = value.trim();
    const validationError = validateName?.(name) ?? null;
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    onCreate(name);
  }, [busy, onCreate, validateName, value]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busy) onCancel();
      } else if (e.key === "Enter" && e.target === inputRef.current) {
        e.preventDefault();
        submit();
      }
    },
    [busy, onCancel, submit],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-file-dialog-title"
      onKeyDown={onKeyDown}
    >
      <div className="w-full max-w-sm rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="new-file-dialog-title" className="text-lg font-semibold text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded p-1 text-foreground-muted hover:text-foreground"
            aria-label="Cancel"
          >
            x
          </button>
        </div>
        <p className="mt-3 text-xs text-foreground-muted">{description}</p>
        {children}
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          className="mt-3 w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground focus:border-border-interactive focus:outline-none"
          autoComplete="off"
        />
        {error || externalError || errorMessage ? (
          <p role="alert" className="mt-2 text-sm text-error">
            {error ?? externalError ?? errorMessage}
          </p>
        ) : null}
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
