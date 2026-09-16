import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

const MAX_PATH_LEN = 4096;

function validateArtifactRenamePath(raw: string): { ok: true; path: string } | { ok: false; reason: string } {
  const path = raw.trim();
  if (path.length === 0) return { ok: false, reason: "Path cannot be empty." };
  if (path.startsWith("/") || path.startsWith("\\")) {
    return { ok: false, reason: "Path must not start with a slash." };
  }
  if (path.split("/").some((seg) => seg === "..")) {
    return { ok: false, reason: "Path must not contain .." };
  }
  if (path.length > MAX_PATH_LEN) return { ok: false, reason: `Path must be at most ${MAX_PATH_LEN} characters.` };
  return { ok: true, path };
}

export interface RenameArtifactDialogProps {
  initialPath: string;
  onSave: (newPath: string) => void;
  onCancel: () => void;
}

export function RenameArtifactDialog({ initialPath, onSave, onCancel }: RenameArtifactDialogProps) {
  const [value, setValue] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = useCallback(() => {
    const v = validateArtifactRenamePath(value);
    if (!v.ok) {
      setError(v.reason);
      return;
    }
    setError(null);
    onSave(v.path);
  }, [value, onSave]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    },
    [onCancel, submit],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-artifact-title"
      onKeyDown={onKeyDown}
    >
      <div className="w-full max-w-sm rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="rename-artifact-title" className="text-lg font-semibold text-primary">
            Rename artifact
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-foreground-muted hover:text-foreground"
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>
        <p className="mt-3 text-xs text-foreground-muted">Logical workspace path (use / between segments).</p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          className="mt-3 w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground focus:border-border-interactive focus:outline-none"
          autoComplete="off"
        />
        {error && <p className="mt-2 text-sm text-error">{error}</p>}
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
