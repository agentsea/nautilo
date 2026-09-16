import { useEffect, useRef, useState } from "react";

export interface TerminalControlConsentDialogProps {
  assistantName: string;
  onCancel: () => void | Promise<void>;
  onConfirm: () => void | Promise<void>;
}

export function TerminalControlConsentDialog({
  assistantName,
  onCancel,
  onConfirm,
}: TerminalControlConsentDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || submitting) return;
      event.preventDefault();
      event.stopPropagation();
      void onCancel();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel, submitting]);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="terminal-control-consent-title"
      aria-describedby="terminal-control-consent-description"
      data-testid="terminal-control-consent-dialog"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-background-panel p-5 shadow-xl">
        <h2 id="terminal-control-consent-title" className="text-base font-semibold text-foreground">
          Let {assistantName} drive this terminal?
        </h2>
        <p
          id="terminal-control-consent-description"
          className="mt-2 text-sm leading-5 text-foreground-muted"
        >
          {assistantName} can type and run commands in this terminal using your macOS account.
          {" "}You can take control at any time.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => void onCancel()}
            disabled={submitting}
            className="rounded border border-border px-3 py-1.5 text-sm text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={submitting}
            className="rounded bg-primary px-3 py-1.5 text-sm font-semibold text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
          >
            Let {assistantName} drive
          </button>
        </div>
      </div>
    </div>
  );
}
