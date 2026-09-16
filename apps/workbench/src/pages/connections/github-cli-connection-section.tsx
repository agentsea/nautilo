import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../hooks/use-auth";
import {
  desktopAPI,
  isDesktop,
  type DesktopGitHubCliStatus,
} from "../../lib/desktop";
import { stableViewerKeyForStorage } from "../../rooms/room-navigation-storage";
import { Button, StatusPill } from "../settings/ui";
import { ConnectionDisclosureControl, useConnectionDisclosure } from "./connection-disclosure";

export function GitHubCliConnectionSection({
  isDesktopShell = isDesktop,
  routeHash,
  routeKey,
}: {
  isDesktopShell?: boolean;
  routeHash?: string;
  routeKey?: string;
} = {}) {
  const auth = useAuth();
  const connection = isDesktopShell ? desktopAPI?.githubCli : undefined;
  const [status, setStatus] = useState<DesktopGitHubCliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<{ url: string; code: string } | null>(null);
  const disclosure = useConnectionDisclosure({
    cardId: "github-cli",
    viewerKey: stableViewerKeyForStorage(auth.viewer),
    forceOpen: busy || (device !== null && !status?.authenticated) || error !== null,
    routeHash,
    routeKey,
  });

  const refresh = useCallback(async () => {
    if (!connection) return;
    try {
      setStatus(await connection.status());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!device || status?.authenticated) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [device, refresh, status?.authenticated]);

  const connect = async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      setDevice(await connection.connect());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  if (!connection) {
    return (
      <div id="github-cli" tabIndex={-1} className="rounded-lg border border-border bg-background-panel outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-labelledby="github-cli-connection-title">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
          <div className="min-w-0"><h3 id="github-cli-connection-title" className="text-sm font-medium text-foreground">GitHub CLI</h3><p className="mt-1 text-xs text-foreground-muted">Available in the Nautilo desktop app.</p></div>
          <ConnectionDisclosureControl expanded={disclosure.expanded} detailsId={disclosure.detailsId} onToggle={disclosure.toggle} />
        </div>
        <div id={disclosure.detailsId} hidden={!disclosure.expanded} className="px-4 pb-4 text-sm text-foreground-muted">GitHub CLI integration is available in the Nautilo desktop app.</div>
      </div>
    );
  }

  const pill = !status
    ? { tone: "info" as const, label: "Checking" }
    : !status.installed
      ? { tone: "warn" as const, label: "gh not installed" }
      : status.authenticated
        ? { tone: "ok" as const, label: "Signed in" }
        : { tone: "muted" as const, label: "Signed out" };

  return (
    <div id="github-cli" tabIndex={-1} className="rounded-lg border border-border bg-background-panel outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-labelledby="github-cli-connection-title">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="github-cli-connection-title" className="text-sm font-medium text-foreground">GitHub CLI</h3>
            <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
          </div>
          <p className="mt-1 text-xs text-foreground-muted">
            Full host <code>gh</code>, <code>gh api</code>, GraphQL, Git, worktrees, and
            installed developer tooling—not a reduced GitHub command subset.
          </p>
          {status?.authenticated ? (
            <p className="mt-2 text-xs text-foreground-muted">
              {status.login ? `github.com · ${status.login}` : "github.com"}
              {status.version ? ` · gh ${status.version}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <ConnectionDisclosureControl expanded={disclosure.expanded} detailsId={disclosure.detailsId} onToggle={disclosure.toggle} />
          <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
          {status?.installed && !status.authenticated ? (
            <Button variant="secondary" loading={busy} onClick={() => void connect()}>
              Sign in to GitHub
            </Button>
          ) : null}
        </div>
      </div>

      <div id={disclosure.detailsId} hidden={!disclosure.expanded} className="px-4 pb-4">
      {device && !status?.authenticated ? (
        <div className="mt-4 rounded-md border border-border bg-background px-3 py-3">
          <p className="text-xs text-foreground-muted">
            GitHub opened in your browser. Enter this one-time code:
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-background-tertiary px-2 py-1 text-sm font-semibold tracking-widest text-foreground">
              {device.code}
            </code>
            <Button
              variant="ghost"
              onClick={() => void navigator.clipboard.writeText(device.code)}
            >
              Copy code
            </Button>
            <Button
              variant="ghost"
              onClick={() => void connection.openDevicePage()}
            >
              Open GitHub
            </Button>
          </div>
          <a
            className="mt-2 block break-all text-xs text-[var(--accent)] underline"
            href={device.url}
            onClick={(event) => {
              event.preventDefault();
              void connection.openDevicePage();
            }}
          >
            {device.url}
          </a>
        </div>
      ) : null}

      {!status?.installed && status ? (
        <p className="mt-3 text-xs text-foreground-muted">
          Install the official GitHub CLI, then refresh. Nautilo uses its normal host
          configuration under <code>~/.config/gh</code>.
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-3 text-xs text-[var(--error)]">{error}</p> : null}
      </div>
    </div>
  );
}
