import { useCallback, useEffect, useState } from "react";
import { desktopAPI } from "../../../lib/desktop";
import { Button, StatusPill } from "../ui";

export function WorkstationShellAccess() {
  const shell = desktopAPI?.workstationShell;
  const [status, setStatus] = useState<{
    workspacePath: string | null;
    consented: boolean;
    consent: "none" | "session" | "durable";
  } | null>(null);

  const refresh = useCallback(async () => {
    if (shell) setStatus(await shell.status());
  }, [shell]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!shell) return null;

  return (
    <details
      aria-labelledby="host-command-access-title"
      className="group rounded-md border border-border bg-background-secondary"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="host-command-access-title" className="text-sm font-semibold text-foreground">
              Host command access
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-foreground-muted">
            Login shell, installed CLIs, and developer credentials.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={status?.consented ? "warn" : "muted"}>
            {status?.consent === "durable"
              ? "Always allowed"
              : status?.consent === "session"
                ? "Allowed this session"
                : "Consent on first use"}
          </StatusPill>
          <span
            aria-hidden="true"
            className="text-xs text-foreground-muted transition-transform group-open:rotate-90"
          >
            ›
          </span>
        </div>
      </summary>
      <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border px-4 py-4">
        <div className="min-w-0">
          <p className="text-xs text-foreground-muted">
            Genie can run commands in the Current Folder with your real login-shell
            environment. Choose app-session or durable folder access on first use. Critical
            destruction or elevation still requires normal approval.
          </p>
          {status?.workspacePath ? (
            <p className="mt-2 truncate text-xs text-foreground-dim" title={status.workspacePath}>
              {status.workspacePath}
            </p>
          ) : null}
        </div>
        {status?.consented ? (
          <Button
            variant="secondary"
            onClick={() => void shell.revoke().then(refresh)}
            ariaLabel="Revoke host command access"
          >
            Revoke
          </Button>
        ) : null}
      </div>
    </details>
  );
}
