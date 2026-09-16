import { useEffect, useRef, useState } from "react";

function basenameOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

export interface ConversionConflictDialogProps {
  /** The target path that already exists (workspace-logical or current-folder-relative). */
  targetPath: string;
  /** Server-supplied collision message (shown as secondary text). */
  message?: string;
  onOverwrite: () => void;
  /** Called with the chosen new basename (not a full path). */
  onRename: (newBasename: string) => void;
  onCancel: () => void;
}

/**
 * M205 — shared "target already exists" resolver for BOTH import and export,
 * across workspace artifacts and current-folder files.
 *
 * UX: the emphasized (primary) button follows the user's INTENT, so the safe
 * action is always the one under the cursor:
 *   - As soon as the name field differs from the existing file, "Save as new
 *     name" becomes the primary button and Enter commits the rename.
 *   - "Overwrite" is a deliberately de-emphasized, destructive-styled action —
 *     never the big primary button and never triggered by Enter — so it can't
 *     be clicked (or Enter'd) by accident while renaming.
 */
export function ConversionConflictDialog({
  targetPath,
  message,
  onOverwrite,
  onRename,
  onCancel,
}: ConversionConflictDialogProps) {
  const initialName = basenameOf(targetPath);
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the stem (before the extension) so a quick retype keeps the ext.
    const dot = initialName.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initialName.length);
  }, [initialName]);

  const trimmed = name.trim();
  // A rename is only meaningful when the name actually differs; renaming to the
  // SAME name is just an overwrite, so the rename action stays disabled there.
  const nameChanged = trimmed.length > 0 && trimmed !== initialName;

  const submitRename = () => {
    if (nameChanged) onRename(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conversion-conflict-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="conversion-conflict-title" className="text-lg font-semibold text-primary">
            File already exists
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-foreground-muted hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p className="mt-3 text-sm text-foreground-muted">
          <span className="font-mono text-foreground">{targetPath}</span> already exists. Save it
          under a new name to keep both files, or replace the existing one.
        </p>

        <label className="mt-4 block text-xs font-medium text-foreground-muted" htmlFor="conversion-conflict-name">
          Save as
        </label>
        <input
          id="conversion-conflict-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // Enter commits the SAFE rename only; it never overwrites.
              submitRename();
            }
          }}
          data-testid="conversion-conflict-name-input"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-accent"
          aria-label="New file name"
        />
        <p className="mt-1.5 text-[11px] text-foreground-dim">
          {nameChanged
            ? "Saves a new file — the existing one is kept."
            : "Type a different name to keep both files."}
        </p>

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element"
          >
            Cancel
          </button>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onOverwrite}
              data-testid="conversion-conflict-overwrite"
              title="Replace the existing file"
              className="rounded-md border border-[var(--error)]/50 px-3 py-2 text-sm text-[var(--error)] hover:bg-[var(--error)]/10"
            >
              Overwrite
            </button>
            <button
              type="button"
              onClick={submitRename}
              disabled={!nameChanged}
              data-testid="conversion-conflict-rename"
              className="rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save as new name
            </button>
          </div>
        </div>
        {message ? (
          <p className="mt-3 truncate text-[11px] text-foreground-dim" title={message}>
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
