interface TerminalControlRequestDockProps {
  sessionId: string;
  assistantName: string;
  onApprove: () => void | Promise<void>;
  onDeny: () => void | Promise<void>;
  onOpenTerminal: () => void;
}

export function TerminalControlRequestDock({
  sessionId,
  assistantName,
  onApprove,
  onDeny,
  onOpenTerminal,
}: TerminalControlRequestDockProps) {
  return (
    <div
      data-testid="terminal-control-request-dock"
      role="status"
      aria-live="polite"
      aria-label="Terminal control requested"
      className="border-t border-border bg-background-panel px-3 py-2 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {assistantName} wants to drive terminal {sessionId}
          </div>
          <div className="mt-0.5 text-xs text-foreground-muted">
            Approving hands the keyboard to {assistantName}. You can take control back from
            the terminal surface at any time.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onDeny()}
          className="rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
          aria-label="Deny terminal control request"
          title="Deny"
        >
          ×
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onApprove()}
          className="rounded border border-primary/50 bg-background-element px-2.5 py-1 text-xs font-semibold text-foreground shadow-sm hover:bg-[var(--primary-muted)]"
        >
          Let {assistantName} drive
        </button>
        <button
          type="button"
          onClick={onOpenTerminal}
          className="rounded border border-border px-2.5 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
        >
          Open terminal
        </button>
        <button
          type="button"
          onClick={() => void onDeny()}
          className="rounded px-2.5 py-1 text-xs text-foreground-muted hover:bg-muted hover:text-foreground"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
