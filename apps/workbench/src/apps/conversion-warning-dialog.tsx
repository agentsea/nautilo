import { useEffect, useRef, useState } from "react";

export type WorkspaceDestination = "current" | "source";
export type ConversionWarningConfirmation = {
  filename: string;
  workspaceDestination: WorkspaceDestination;
};

export interface ConversionWarningDialogProps {
  warnings: readonly string[];
  message?: string;
  workspaceDestination?: {
    filename: string;
    extension: string;
    initialLocation: WorkspaceDestination;
  };
  onConfirm: (choice?: ConversionWarningConfirmation) => void;
  onCancel: () => void;
}

export function ConversionWarningDialog({
  warnings,
  message,
  workspaceDestination,
  onConfirm,
  onCancel,
}: ConversionWarningDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const settledRef = useRef(false);
  const [filename, setFilename] = useState(workspaceDestination?.filename ?? "");
  const [location, setLocation] = useState<WorkspaceDestination>(workspaceDestination?.initialLocation ?? "current");
  const requiredExtension = workspaceDestination?.extension ?? "";
  const hasForbiddenFilenameCharacter = [...filename].some((character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || character === ":" || code < 32 || code === 127;
  });
  const filenameValid = !workspaceDestination || (
    filename === filename.trim() &&
    filename.length > requiredExtension.length &&
    filename.toLowerCase().endsWith(requiredExtension.toLowerCase()) &&
    !hasForbiddenFilenameCharacter
  );

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  const settle = (choice: "confirm" | "cancel") => {
    if (choice === "confirm" && !filenameValid) return;
    if (settledRef.current) return;
    settledRef.current = true;
    if (choice === "confirm") {
      onConfirm(workspaceDestination ? { filename, workspaceDestination: location } : undefined);
    }
    else onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conversion-warning-title"
      aria-describedby="conversion-warning-description"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          settle("cancel");
        } else if (event.key === "Tab") {
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled])',
          )];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="flex max-h-[min(42rem,calc(100vh-2rem))] w-full max-w-lg flex-col rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
        <h2 id="conversion-warning-title" className="text-lg font-semibold text-primary">
          {workspaceDestination ? "Export copy" : "Review conversion warnings"}
        </h2>
        <p id="conversion-warning-description" className="mt-3 text-sm text-foreground-muted">
          {message ?? "Some content may look different in the converted copy."}
        </p>

        {workspaceDestination ? (
          <div className="mt-4 grid gap-4 rounded-md border border-border bg-background p-4">
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              File name
              <input
                value={filename}
                onChange={(event) => setFilename(event.target.value)}
                aria-invalid={!filenameValid}
                className="rounded-md border border-border bg-background-panel px-3 py-2 font-normal text-foreground outline-none focus:border-primary"
              />
            </label>
            {!filenameValid ? (
              <p className="text-xs text-danger" role="alert">
                Enter one file name ending in {requiredExtension}.
              </p>
            ) : null}
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Save in
              <select
                value={location}
                onChange={(event) => setLocation(event.target.value as WorkspaceDestination)}
                className="rounded-md border border-border bg-background-panel px-3 py-2 font-normal text-foreground outline-none focus:border-primary"
              >
                <option value="current">This chat’s workspace</option>
                <option value="source">Beside the original</option>
              </select>
            </label>
            <p className="text-xs text-foreground-muted">The original file is preserved.</p>
          </div>
        ) : null}

        <ul
          className="mt-4 min-h-0 flex-1 list-disc space-y-2 overflow-y-auto rounded-md border border-border bg-background p-4 pl-8 text-sm text-foreground"
          data-testid="conversion-warning-list"
        >
          {warnings.map((warning, index) => (
            <li key={index} className="whitespace-pre-wrap break-words">
              {warning}
            </li>
          ))}
        </ul>

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => settle("cancel")}
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:bg-background-element"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => settle("confirm")}
            data-testid="conversion-warning-confirm"
            disabled={!filenameValid}
            className="rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
          >
            {workspaceDestination ? "Export copy" : "Create converted copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
