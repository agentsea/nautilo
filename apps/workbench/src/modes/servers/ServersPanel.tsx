import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { connectionFailureCopy, connectionPairingTruthCopy, connectionPhaseCopy } from "../../../../desktop/electron/connection-presentation";
import { formatConnectionSupportReceipt } from "../../../../desktop/electron/connection-support-receipt";
import { copyTextToClipboard } from "../../lib/copy-to-clipboard";
import {
  desktopAPI,
  type DesktopConnectionPresentation,
  type DesktopServerAddResult,
  type DesktopServerListEntry,
  type DesktopServerForgetResult,
  type DesktopServerListResult,
  type DesktopServerSwitchResult,
} from "../../lib/desktop";
import { ServerIcon } from "../../components/server/server-icon";
import {
  ServerAttentionBadge,
  aggregateServerAttentionPresentation,
  serverAttentionPresentation,
} from "./server-attention";

const REFRESH_INTERVAL_MS = 15_000;

function storedWorkbenchTheme(): "light" | "dark" | null {
  try {
    const theme = window.localStorage.getItem("nautilo-theme");
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function serverName(server: DesktopServerListEntry): string {
  return server.name?.trim() || hostOf(server.url);
}

function statusCopy(server: DesktopServerListEntry): string {
  if (server.connection === "incompatible") return "Server update required";
  if (server.connection === "offline") return "Offline";
  if (server.connection === "connecting") return "Connecting";
  // Only the active session has authoritative in-process auth truth. A
  // recent/inactive row may have valid persisted credentials that are not
  // loaded until activation, so `signedIn: false` there means unknown rather
  // than "sign-in required".
  if (server.active && !server.signedIn) return "Sign-in required";
  return server.active ? "Active" : "Live";
}

function switchFailureCopy(result: Exclude<DesktopServerSwitchResult | DesktopServerAddResult, { ok: true }>): string {
  switch (result.reason) {
    case "cancelled": return "Connection cancelled.";
    case "unknown-server":
      return "This server is no longer available.";
    case "offline":
      return "This server is offline. Check the connection and try again.";
    case "incompatible":
      return "This server requires a server update before it can be opened.";
    case "fingerprint-storage-failed":
      return "Could not securely save this server’s identity. Try again.";
    case "wrong-server":
      return "This is not the expected server.";
    case "stale": return "A newer connection attempt replaced this one. Try again.";
    case "identity-changed-again": return "The server identity changed again. Start a fresh check.";
    case "invalid-target": return "This server address is no longer valid.";
    case "promotion-failed":
      return result.authoritativePairingChanged === false
        ? "Nautilo could not save the connection. Your current server remains active."
        : "Nautilo could not finish the saved connection. Select it again to resume safely.";
  }
}

function forgetFailureCopy(result: Exclude<DesktopServerForgetResult, { ok: true }>): string {
  switch (result.reason) {
    case "invalid-url":
    case "unknown-server":
      return "This server is no longer available.";
    case "partition-clear-failed":
      return "Some saved browsing data could not be cleared. Try again.";
    case "config-clear-failed":
      return "The server was removed, but its saved start state could not be cleared.";
  }
}

export interface ServersPanelProps {
  onCollapse: () => void;
  /** Main-owned lifecycle state; inactive renderers must not call server IPC. */
  activeSession?: boolean;
}

export function ServersPanel({
  onCollapse,
  activeSession = true,
}: ServersPanelProps): ReactElement {
  const [servers, setServers] = useState<DesktopServerListEntry[]>([]);
  const [aggregate, setAggregate] = useState<
    DesktopServerListResult["aggregate"]
  >({
    unreadCount: 0,
    importantUnreadCount: 0,
    unavailableServerCount: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [identityDecision, setIdentityDecision] = useState<string | null>(null);
  const [switchingUrl, setSwitchingUrl] = useState<string | null>(null);
  const [menuUrl, setMenuUrl] = useState<string | null>(null);
  const [forgetTarget, setForgetTarget] = useState<DesktopServerListEntry | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [connectionPresentation, setConnectionPresentation] = useState<DesktopConnectionPresentation | null>(null);
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | null>(null);
  const requestId = useRef(0);
  const presentationBaseline = useRef(0);
  const identityActionRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    if (!activeSession) return;
    const id = ++requestId.current;
    try {
      const next = await desktopAPI?.servers?.list?.();
      if (id === requestId.current && next) {
        setServers(next.servers);
        setAggregate(next.aggregate);
      }
    } catch {
      // Retain the last known rows: a transient refresh must not blank the panel.
    }
  }, [activeSession]);

  useEffect(() => {
    if (!activeSession) {
      requestId.current += 1;
      return;
    }
    void refresh();
    const unsubscribe = desktopAPI?.servers?.onChanged?.(() => void refresh());
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      requestId.current += 1;
      window.clearInterval(interval);
      unsubscribe?.();
    };
  }, [activeSession, refresh]);

  useEffect(() => {
    if (!activeSession) return;
    const receive = (next: DesktopConnectionPresentation) => {
      if (next.revision <= presentationBaseline.current) return;
      setConnectionPresentation((current) => current && current.revision >= next.revision ? current : next);
      setCopyResult(null);
    };
    return desktopAPI?.servers?.onConnectionPresentation?.(receive);
  }, [activeSession]);

  useEffect(() => {
    if (identityDecision) queueMicrotask(() => identityActionRef.current?.focus());
  }, [identityDecision]);

  const switchTo = async (url: string) => {
    setError(null);
    presentationBaseline.current = connectionPresentation?.revision ?? presentationBaseline.current;
    setConnectionPresentation(null);
    setIdentityDecision(null);
    setSwitchingUrl(url);
    try {
      const theme = storedWorkbenchTheme();
      const result = await desktopAPI?.servers?.switchTo?.(
        url,
        ...(theme ? [theme] as const : []),
      );
      if (!result) {
        setError("Server switching is unavailable in this desktop build.");
      } else if (!result.ok) {
        setError(switchFailureCopy(result));
        if (result.reason === "wrong-server") setIdentityDecision(result.decisionId);
      }
    } catch {
      setError("Could not switch servers. Try again.");
    } finally {
      setSwitchingUrl(null);
    }
  };

  const acceptIdentity = async () => {
    if (!identityDecision) return;
    presentationBaseline.current = connectionPresentation?.revision ?? presentationBaseline.current;
    setConnectionPresentation(null);
    setSwitchingUrl("identity-acceptance");
    const decisionId = identityDecision;
    setIdentityDecision(null);
    try {
      const result = await desktopAPI?.servers?.acceptIdentity?.(decisionId);
      if (!result?.ok) {
        setError(result?.reason === "identity-changed-again"
          ? "The server identity changed again. Select the server to start a fresh check."
          : "The server identity could not be accepted. Select the server to retry.");
      } else {
        setError(null);
        await refresh();
      }
    } catch {
      setError("The server identity could not be accepted. Select the server to retry.");
    } finally {
      setSwitchingUrl(null);
    }
  };

  const addServer = async () => {
    setError(null);
    presentationBaseline.current = connectionPresentation?.revision ?? presentationBaseline.current;
    setConnectionPresentation(null);
    setSwitchingUrl("add-server");
    try {
      const theme = storedWorkbenchTheme();
      const result = await desktopAPI?.servers?.add?.(
        ...(theme ? [theme] as const : []),
      );
      if (!result) {
        setError("Connecting to another server is unavailable in this desktop build.");
      } else if (!result.ok && result.reason !== "cancelled") {
        setError(result.reason === "wrong-server" ? "This is not the expected server." : switchFailureCopy(result));
      } else if (result.ok) {
        await refresh();
      }
    } catch {
      setError("Could not connect to that server. Try again.");
    } finally {
      setSwitchingUrl(null);
    }
  };

  const forgetServer = async () => {
    if (!forgetTarget) return;
    const target = forgetTarget;
    setError(null);
    setForgetting(true);
    try {
      const result = await desktopAPI?.servers?.forget?.(target.url);
      if (!result) {
        setError("Forgetting servers is unavailable in this desktop build.");
      } else if (!result.ok) {
        setError(forgetFailureCopy(result));
      } else {
        if (result.fallbackFailed) {
          setError("The fallback server could not be reached, so Nautilo returned to Connect.");
        }
        await refresh();
      }
    } catch {
      setError("Could not forget this server. Try again.");
    } finally {
      setForgetting(false);
      setForgetTarget(null);
    }
  };

  const canForget = typeof desktopAPI?.servers?.forget === "function";
  const onlyServer = servers.length === 1;
  const aggregateAttention = aggregateServerAttentionPresentation(aggregate);

  return (
    <aside
      data-testid="servers-panel"
      className="relative grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] overflow-clip border-r border-border bg-background-panel"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-foreground">
          Servers
          <span data-testid="servers-panel-aggregate-summary" className="sr-only">
            {aggregateAttention?.ariaLabel}
          </span>
        </span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Hide servers panel"
          title="Hide servers panel"
          className="flex shrink-0 items-center justify-center rounded-md px-2 py-1 text-sm leading-5 text-foreground-muted transition-colors hover:bg-[var(--primary-muted)] hover:text-foreground"
        >
          <span aria-hidden="true">‹</span>
        </button>
      </header>

      <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto p-2">
        <div className="grid min-w-0 gap-1">
          {servers.map((server) => {
            const name = serverName(server);
            const description = server.description?.trim();
            const host = hostOf(server.url);
            const identityLabel = [name, description, host === name ? null : host]
              .filter((value): value is string => typeof value === "string" && value.length > 0)
              .join(". ");
            const attention = serverAttentionPresentation(
              server.notificationSummary,
              name,
            );
            return (
            <div
              key={server.url}
              data-testid="servers-panel-row"
              data-active={server.active || undefined}
              className={[
                "relative flex min-w-0 max-w-full items-center gap-1 rounded-md",
                server.active
                  ? "bg-[var(--primary-muted)] text-foreground"
                  : "text-foreground hover:bg-[var(--primary-muted)]",
              ].join(" ")}
            >
              <button
                type="button"
                aria-label={`${identityLabel}. ${statusCopy(server)}${
                  attention ? `. ${attention.ariaLabel}` : ""
                }`}
                disabled={switchingUrl !== null || forgetting}
                onClick={() => void switchTo(server.url)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors disabled:opacity-60"
              >
                <ServerIcon
                  icon={undefined}
                  imageUrl={server.iconUrl}
                  size={28}
                  fallbackInitial={name}
                />
                <span className="min-w-0 flex-1 overflow-hidden">
                  <span
                    data-testid="servers-panel-row-name"
                    title={name}
                    className="block truncate text-sm font-medium"
                  >
                    {name}
                  </span>
                  {description ? (
                    <span
                      data-testid="servers-panel-row-description"
                      title={description}
                      className="block truncate text-xs text-foreground-muted"
                    >
                      {description}
                    </span>
                  ) : null}
                  <span
                    title={host}
                    className="block truncate text-xs text-foreground-muted"
                    data-testid="servers-panel-row-host"
                  >
                    {host}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] text-foreground-muted">
                  {attention?.stale ? (
                    <span data-testid="servers-panel-last-known">Last known</span>
                  ) : null}
                  {!server.active ? (
                    <ServerAttentionBadge
                      attention={attention}
                      testId="servers-panel-row-attention"
                    />
                  ) : null}
                  <span>
                    {switchingUrl === server.url ? "Switching…" : statusCopy(server)}
                  </span>
                </span>
              </button>
              {canForget ? (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    data-testid="servers-panel-overflow"
                    aria-label={`Server actions for ${serverName(server)}`}
                    aria-expanded={menuUrl === server.url}
                    onClick={() => setMenuUrl((current) => current === server.url ? null : server.url)}
                    className="rounded-md p-2 text-foreground-muted hover:bg-background hover:text-foreground"
                  >
                    <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                  </button>
                  {menuUrl === server.url ? (
                    <div role="menu" className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-border bg-background p-1 shadow-lg">
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="servers-panel-forget-menu-item"
                        onClick={() => {
                          setMenuUrl(null);
                          setForgetTarget(server);
                        }}
                        className="w-full rounded px-2 py-1.5 text-left text-sm text-[var(--error)] hover:bg-[var(--primary-muted)]"
                      >
                        Forget server…
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            );
          })}
        </div>
        {error ? (
          <div className="mt-2 rounded-md bg-[var(--error)]/10 px-2 py-1.5 text-xs text-[var(--error)]">
            <div role="alert">
              <p>{connectionPresentation?.failureCode ? connectionFailureCopy(connectionPresentation.failureCode) : error}</p>
              {connectionPresentation ? <p className="mt-1">{connectionPairingTruthCopy(connectionPresentation)}</p> : null}
            </div>
            {connectionPresentation?.supportReceipt ? <button type="button"
              onClick={() => void copyTextToClipboard(formatConnectionSupportReceipt(connectionPresentation.supportReceipt!))
                .then((ok) => setCopyResult(ok ? "copied" : "failed"))}
              className="mt-2 rounded border border-[var(--error)] px-2 py-1 font-medium">
              Copy diagnostic details
            </button> : null}
            {copyResult ? <p role="status" aria-live="polite" className="mt-1">
              {copyResult === "copied" ? "Diagnostic details copied." : "Could not copy diagnostic details."}
            </p> : null}
            {identityDecision ? (
              <button ref={identityActionRef} type="button" onClick={() => void acceptIdentity()}
                className="mt-2 rounded border border-[var(--error)] px-2 py-1 font-medium">
                Use this server identity
              </button>
            ) : null}
          </div>
        ) : null}
        {switchingUrl && connectionPresentation ? (
          <p role="status" aria-live="polite" data-testid="servers-connection-progress"
            className="mt-2 flex items-center rounded-md bg-[var(--primary-muted)] px-2 py-1.5 text-xs text-foreground-muted">
            <ConnectionActivity />
            {connectionPhaseCopy(connectionPresentation.phase)}
          </p>
        ) : null}
      </div>

      <footer className="border-t border-border p-2">
        <button
          type="button"
          data-testid="servers-panel-add"
          onClick={() => void addServer()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-[var(--primary-muted)]"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          Connect to server…
        </button>
      </footer>
      {forgetTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="forget-server-title"
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl">
            <h2 id="forget-server-title" className="text-sm font-semibold">Forget {serverName(forgetTarget)}?</h2>
            <p className="mt-2 text-sm text-foreground-muted">
              This removes the server from Recents and clears its saved sign-in, relay token,
              browsing data, and recents. It is not Disconnect or Sign out.
            </p>
            <p className="mt-2 text-sm text-foreground-muted">
              {onlyServer && forgetTarget.active
                ? "This is your only server, so Nautilo will return to the empty Connect state."
                : forgetTarget.active
                  ? "Nautilo will switch to your most recently used remaining server first."
                  : "Other connected servers will remain available."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={forgetting}
                onClick={() => setForgetTarget(null)}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-[var(--primary-muted)]"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="servers-panel-forget-confirm"
                disabled={forgetting}
                onClick={() => void forgetServer()}
                className="rounded-md bg-[var(--error)] px-3 py-1.5 text-sm text-white disabled:opacity-60"
              >
                {forgetting ? "Forgetting…" : "Forget server"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function ConnectionActivity() {
  return <span aria-hidden="true" className="mr-2 inline-flex items-center gap-1">
    {[0, 140, 280].map((delay) => <span key={delay}
      className="h-1.5 w-1.5 animate-pulse rounded-[2px] bg-primary motion-reduce:animate-none"
      style={{ animationDelay: `${delay}ms` }} />)}
  </span>;
}
