/**
 * First-run mode picker (D057 2a.2).
 *
 * Rendered inside a dedicated Electron BrowserWindow on first launch
 * (when userData/config.json is missing or stale). D134 retired the
 * packaged-local server path: this picker has one job—connect the desktop
 * client to a Nautilo server.
 *
 * Connect runs the main-owned transaction. The picker closes only after the
 * candidate is verified and its active authority is atomically committed.
 *
 * Vanilla React 19 — no router, no state library, no animation deps.
 * Bundles as a single IIFE loaded from index.html. Lives OUTSIDE the
 * workbench so time-to-interactive doesn't depend on workbench's bundle.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectionFailureCopy, connectionPairingTruthCopy, connectionPhaseCopy,
  type ConnectionPresentation } from "../electron/connection-presentation";
import { formatConnectionSupportReceipt } from "../electron/connection-support-receipt";

// ---------------------------------------------------------------------------
// IPC surface (mirrors what preload.ts exposes). Typed locally so this
// bundle doesn't import from @nautilo/desktop.
// ---------------------------------------------------------------------------

type DesktopMode = "connect";

interface DesktopConfig {
  version: 1;
  mode: DesktopMode;
  serverUrl?: string;
}

type ConnectionResult =
  | { ok: true; url: string }
  | { ok: false; reason: "downgrade-confirmation-required"; decisionId: string }
  | { ok: false; reason: "wrong-server"; decisionId: string }
  | { ok: false; reason: "invalid-target" | "offline" | "incompatible" | "stale" | "identity-changed-again" }
  | { ok: false; reason: "promotion-failed"; authoritativePairingChanged: false | true | "unknown" };

type PickerCandidate = {
  label: string;
  url: string;
  source: "layout" | "mdns";
};

type RecentServerEntry = {
  url: string;
  displayName?: string;
  lastUsedAt: string;
};

type ConnectTargetsPayload = {
  candidates: PickerCandidate[];
  recentServers: RecentServerEntry[];
  suggestedUrl: string | null;
  mode: "first-run" | "switch-server" | "add-server";
  currentServerUrl: string | null;
  localDiscovery: { kind: "completed" | "unavailable" };
};

interface FirstRunAPI {
  getConnectTargets: () => Promise<ConnectTargetsPayload>;
  commit: (cfg: DesktopConfig) => Promise<ConnectionResult>;
  confirmDowngrade: (decisionId: string) => Promise<ConnectionResult>;
  acceptIdentity: (decisionId: string) => Promise<ConnectionResult>;
  abortAttempt: () => Promise<boolean>;
  onConnectionPresentation: (cb: (snapshot: ConnectionPresentation) => void) => () => void;
  cancel: () => Promise<void>;
}

// exposed on window.nautiloFirstRun by preload-first-run.ts
const api: FirstRunAPI | undefined = (
  window as unknown as { nautiloFirstRun?: FirstRunAPI }
).nautiloFirstRun;

// Public product guidance only. This is placeholder text, not an implicit
// connection target; a fresh install still starts with an empty input.
export const PUBLIC_SERVER_URL_PLACEHOLDER = "community.nautilo.dev";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ProbeStatus =
  | { kind: "idle" }
  | { kind: "error"; reason: string; detail?: string; downgradeDecisionId?: string; identityDecisionId?: string };

type ConnectScanState =
  | { kind: "loading" }
  | {
      kind: "ready";
      candidates: PickerCandidate[];
      recentServers: RecentServerEntry[];
      suggestedUrl: string | null;
      localDiscovery: { kind: "completed" | "unavailable" };
      mode: "first-run" | "switch-server" | "add-server";
      currentServerUrl: string | null;
    };

export function App() {
  const [serverUrl, setServerUrl] = useState("");
  const [probe, setProbe] = useState<ProbeStatus>({ kind: "idle" });
  const [committing, setCommitting] = useState(false);
  const [presentation, setPresentation] = useState<ConnectionPresentation | null>(null);
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | null>(null);
  const [connectScan, setConnectScan] = useState<ConnectScanState>({ kind: "loading" });
  const serverInputRef = useRef<HTMLInputElement>(null);
  const decisionButtonRef = useRef<HTMLButtonElement>(null);

  const scanConnectTargets = useCallback(async () => {
    if (!api?.getConnectTargets) {
      setConnectScan({
        kind: "ready",
        candidates: [],
        recentServers: [],
        suggestedUrl: null,
        localDiscovery: { kind: "unavailable" },
        mode: "first-run",
        currentServerUrl: null,
      });
      return;
    }
    setConnectScan({ kind: "loading" });
    try {
      const r = await api.getConnectTargets();
      setConnectScan({
        kind: "ready",
        candidates: r.candidates,
        recentServers: r.recentServers ?? [],
        suggestedUrl: r.suggestedUrl,
        localDiscovery: r.localDiscovery ?? { kind: "unavailable" },
        mode: r.mode ?? "first-run",
        currentServerUrl: r.currentServerUrl ?? null,
      });
      if (r.suggestedUrl) {
        setServerUrl((prev) => (prev.trim() === "" ? r.suggestedUrl! : prev));
      }
    } catch {
      setConnectScan({
        kind: "ready",
        candidates: [],
        recentServers: [],
        suggestedUrl: null,
        localDiscovery: { kind: "unavailable" },
        mode: "first-run",
        currentServerUrl: null,
      });
    }
  }, []);

  useEffect(() => {
    void scanConnectTargets();
  }, [scanConnectTargets]);

  useEffect(() => {
    if (!api?.onConnectionPresentation) return;
    const receive = (next: ConnectionPresentation) => {
      setPresentation((current) => current && current.revision >= next.revision ? current : next);
      setCopyResult(null);
    };
    return api.onConnectionPresentation(receive);
  }, []);

  const editServerUrl = useCallback(async (url: string) => {
    const displayedDecision = probe.kind === "error" && Boolean(probe.downgradeDecisionId ?? probe.identityDecisionId);
    if (committing || displayedDecision) {
      const cancelled = await api?.abortAttempt();
      if (committing && !cancelled) return;
      setCommitting(false);
    }
    setServerUrl(url);
    setProbe({ kind: "idle" });
  }, [committing, probe]);

  const pickDiscoveredUrl = useCallback((url: string) => {
    void editServerUrl(url);
  }, [editServerUrl]);

  // Reset probe if user edits URL after a probe result.
  useEffect(() => {
    if (probe.kind !== "idle") setProbe({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  const canContinue = useMemo(() => {
    if (committing) return false;
    if (presentation && presentation.pairingStateChange !== "unchanged") {
      return presentation.validActions.includes("resume-handoff");
    }
    return serverUrl.trim().length > 0;
  }, [serverUrl, committing, presentation]);

  const applyConnectionFailure = useCallback((result: Exclude<ConnectionResult, { ok: true }>) => {
    setProbe({
      kind: "error",
      reason: humanizeConnectionFailure(result.reason),
      ...(result.reason === "wrong-server" ? {
        identityDecisionId: result.decisionId,
        detail: "That address is now answering as a different Nautilo. Nothing was changed. Continue only if you intended to replace the saved server identity.",
      } : {}),
      ...(result.reason === "downgrade-confirmation-required" ? {
        downgradeDecisionId: result.decisionId,
        detail: "HTTP does not encrypt this connection. Confirm only if you intended to replace the saved HTTPS route.",
      } : {}),
    });
    setCommitting(false);
    if (result.reason !== "wrong-server" && result.reason !== "downgrade-confirmation-required") {
      queueMicrotask(() => serverInputRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (probe.kind === "error" && (probe.downgradeDecisionId || probe.identityDecisionId)) {
      queueMicrotask(() => decisionButtonRef.current?.focus());
    } else if (!committing && probe.kind === "error") {
      // The blue in-flight surface deliberately replaces the URL form.
      // Restore focus only after React has mounted the form again.
      queueMicrotask(() => serverInputRef.current?.focus());
    }
  }, [committing, probe]);

  const handleContinue = useCallback(async () => {
    if (!api || committing) return;
    setCommitting(true);
    try {
      const cfg: DesktopConfig = { version: 1, mode: "connect", serverUrl: serverUrl.trim() };
      const result = await api.commit(cfg);
      if (!result.ok) applyConnectionFailure(result);
    } catch {
      console.error("[first-run] commit failed");
      setProbe({ kind: "error", reason: "Could not connect to this server. Check the address and try again." });
      setCommitting(false);
      queueMicrotask(() => serverInputRef.current?.focus());
    }
  }, [serverUrl, committing, applyConnectionFailure]);

  const handleConfirmDowngrade = useCallback(async () => {
    if (!api || committing || probe.kind !== "error" || !probe.downgradeDecisionId) return;
    setCommitting(true);
    try {
      const result = await api.confirmDowngrade(probe.downgradeDecisionId);
      if (!result.ok) applyConnectionFailure(result);
    } catch {
      setProbe({ kind: "error", reason: "The confirmation could not be completed. Try connecting again." });
      setCommitting(false);
    }
  }, [committing, probe, applyConnectionFailure]);

  const handleAcceptIdentity = useCallback(async () => {
    if (!api || committing || probe.kind !== "error" || !probe.identityDecisionId) return;
    setCommitting(true);
    try {
      const result = await api.acceptIdentity(probe.identityDecisionId);
      if (!result.ok) applyConnectionFailure(result);
    } catch {
      setProbe({ kind: "error", reason: "The server identity could not be accepted. Connect again to retry safely." });
      setCommitting(false);
    }
  }, [committing, probe, applyConnectionFailure]);

  const switchMode = connectScan.kind === "ready" && connectScan.mode === "switch-server";
  const addMode = connectScan.kind === "ready" && connectScan.mode === "add-server";
  const firstRunMode = !switchMode && !addMode;
  const handleCancel = useCallback(async () => {
    if (committing && firstRunMode) {
      if (await api?.abortAttempt()) {
        setCommitting(false);
        queueMicrotask(() => serverInputRef.current?.focus());
      }
      return;
    }
    await api?.cancel();
  }, [committing, firstRunMode]);
  const currentServerUrl =
    connectScan.kind === "ready" ? connectScan.currentServerUrl : null;
  const visibleRecentServers = connectScan.kind === "ready"
    ? connectScan.recentServers.filter((server) => !isSameServerUrl(server.url, currentServerUrl))
    : [];
  if (committing) {
    return (
      <main style={connectionScreenStyles.root} aria-label="Connecting to server">
        <div style={connectionScreenStyles.mark} aria-hidden>☸</div>
        <h1 style={connectionScreenStyles.title}>Connecting to Nautilo</h1>
        <p role="status" aria-live="polite" style={connectionScreenStyles.status}>
          <ConnectionActivity />
          {presentation
            ? connectionPhaseCopy(presentation.phase)
            : "Preparing your secure sign-in…"}
        </p>
      </main>
    );
  }
  return (
    <form style={layoutStyles.root} onSubmit={(event) => { event.preventDefault(); void handleContinue(); }}>
      <div style={layoutStyles.header}>
        <div style={layoutStyles.logo} aria-hidden>
          ☸
        </div>
        <h1 style={layoutStyles.brand}>NAUTILO</h1>
        <p style={layoutStyles.prompt}>
          {addMode
            ? "Add another Nautilo server"
            : switchMode
              ? "Switch to another Nautilo server"
              : "Connect to your Nautilo server"}
        </p>
      </div>

      <section style={cardStyles.card} aria-label="Server connection">
        {connectScan.kind === "loading" && (
          <p style={cardStyles.scanHint}>Scanning for local Nautilo servers…</p>
        )}
        {connectScan.kind === "ready" && currentServerUrl ? (
          <div style={cardStyles.currentServerBlock}>
            <span style={cardStyles.label}>Currently connected</span>
            <RecentServerButton
              server={{
                url: currentServerUrl,
                lastUsedAt: new Date().toISOString(),
              }}
              current
              onPick={pickDiscoveredUrl}
            />
          </div>
        ) : null}

        {connectScan.kind === "ready" && visibleRecentServers.length > 0 && (
          <div style={cardStyles.discoveredBlock}>
            <span style={cardStyles.label}>Recently connected</span>
            <div style={cardStyles.recentList}>
              {visibleRecentServers.map((server) => (
                <RecentServerButton
                  key={server.url}
                  server={server}
                  current={false}
                  onPick={pickDiscoveredUrl}
                />
              ))}
            </div>
          </div>
        )}

        {connectScan.kind === "ready" && connectScan.candidates.length > 0 && (
          <div style={cardStyles.discoveredBlock}>
            <span style={cardStyles.label}>Discovered on this machine / LAN</span>
            <div style={cardStyles.discoveredList}>
              {connectScan.candidates.map((c) => (
                <button
                  key={c.url}
                  type="button"
                  onClick={() => pickDiscoveredUrl(c.url)}
                  style={cardStyles.discoveredButton}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={cardStyles.section}>
          <label htmlFor="server-url" style={cardStyles.label}>
            Server URL
          </label>
          <div style={cardStyles.row}>
            <input
              id="server-url"
              ref={serverInputRef}
              type="text"
              inputMode="url"
              placeholder={PUBLIC_SERVER_URL_PLACEHOLDER}
              value={serverUrl}
              onChange={(e) => { void editServerUrl(e.target.value); }}
              spellCheck={false}
              autoComplete="off"
              style={cardStyles.input}
            />
          </div>

          <div style={{ minHeight: "18px", marginTop: "8px" }}>
            {committing && presentation ? (
              <span role="status" aria-live="polite" style={cardStyles.stateMessage}>
                <ConnectionActivity />
                {connectionPhaseCopy(presentation.phase)}
              </span>
            ) : null}
            {probe.kind === "error" && (
              <div style={{ color: "var(--error)", fontSize: "12px" }}>
                <span role="alert" aria-live="assertive">✗ {presentation?.failureCode ? connectionFailureCopy(presentation.failureCode) : probe.reason}
                  {probe.detail ? ` — ${probe.detail}` : ""}
                  {presentation ? ` ${connectionPairingTruthCopy(presentation)}` : ""}
                </span>
                {presentation?.supportReceipt ? <button type="button"
                  onClick={() => void copyText(formatConnectionSupportReceipt(presentation.supportReceipt!))
                    .then((ok) => setCopyResult(ok ? "copied" : "failed"))}
                  style={cardStyles.diagnosticButton}>Copy diagnostic details</button> : null}
                {copyResult ? <span role="status" aria-live="polite">
                  {copyResult === "copied" ? " Diagnostic details copied." : " Could not copy diagnostic details."}
                </span> : null}
              </div>
            )}
          </div>
        </div>
      </section>

      <div style={layoutStyles.footer}>
        <button type="button" onClick={() => void handleCancel()}
          disabled={Boolean(presentation && !presentation.validActions.includes("cancel"))}
          style={layoutStyles.cancelButton}>
          Cancel
        </button>
        <button
          ref={decisionButtonRef}
          type={probe.kind === "error" && (probe.downgradeDecisionId || probe.identityDecisionId) ? "button" : "submit"}
          onClick={probe.kind === "error" && probe.downgradeDecisionId
            ? () => void handleConfirmDowngrade()
            : probe.kind === "error" && probe.identityDecisionId
              ? () => void handleAcceptIdentity()
              : undefined}
          disabled={!canContinue}
          style={{
            ...layoutStyles.continueButton,
            opacity: canContinue ? 1 : 0.4,
            cursor: canContinue ? "pointer" : "not-allowed",
          }}
        >
          {committing
            ? "Connecting…"
            : presentation && presentation.pairingStateChange !== "unchanged"
              ? presentation.validActions.includes("resume-handoff") ? "Finish connection" : "Finishing…"
            : probe.kind === "error" && probe.downgradeDecisionId
              ? "Confirm HTTP connection"
              : probe.kind === "error" && probe.identityDecisionId
                ? "Use this server identity"
              : "Connect →"}
        </button>
      </div>
    </form>
  );
}

function ConnectionActivity() {
  return <span className="connection-activity" aria-hidden="true"><span /><span /><span /></span>;
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function RecentServerButton({
  server,
  current,
  onPick,
}: {
  server: RecentServerEntry;
  current: boolean;
  onPick: (url: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(server.url)}
      style={{
        ...cardStyles.discoveredButton,
        ...(current ? cardStyles.currentServerButton : {}),
      }}
    >
      <span style={cardStyles.serverRowHeader}>
        <span style={cardStyles.serverRowTitle}>
          {server.displayName ?? labelForServerUrl(server.url)}
        </span>
        {current ? (
          <span style={cardStyles.currentBadge}>
            <span style={cardStyles.currentDot} aria-hidden />
            Current
          </span>
        ) : null}
      </span>
      <span style={cardStyles.serverRowUrl}>{server.url}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Styles (React-inline so we stay under the strict CSP of index.html)
// ---------------------------------------------------------------------------

const layoutStyles = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  } as React.CSSProperties,
  header: {
    textAlign: "center" as const,
    marginBottom: "8px",
  } as React.CSSProperties,
  logo: {
    fontSize: "42px",
    lineHeight: "42px",
    marginBottom: "4px",
  } as React.CSSProperties,
  brand: {
    margin: 0,
    fontSize: "18px",
    letterSpacing: "4px",
    fontWeight: 600,
  } as React.CSSProperties,
  prompt: {
    marginTop: "12px",
    marginBottom: "4px",
    color: "var(--text-muted)",
    fontSize: "15px",
  } as React.CSSProperties,
  footer: {
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    alignItems: "center",
    marginTop: "8px",
    flexShrink: 0,
  } as React.CSSProperties,
  cancelButton: {
    padding: "10px 16px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
  } as React.CSSProperties,
  continueButton: {
    padding: "10px 20px",
    borderRadius: "var(--radius-sm)",
    border: "none",
    background: "var(--accent)",
    color: "var(--on-accent)",
    fontWeight: 600,
    fontSize: "14px",
  } as React.CSSProperties,
};

const connectionScreenStyles = {
  root: {
    position: "fixed",
    inset: 0,
    display: "grid",
    placeContent: "center",
    justifyItems: "center",
    gap: "14px",
    padding: "32px",
    color: "var(--text)",
    background: "var(--bg)",
  } as React.CSSProperties,
  mark: { fontSize: "52px", lineHeight: 1 } as React.CSSProperties,
  title: { margin: 0, fontSize: "28px", fontWeight: 650 } as React.CSSProperties,
  status: { margin: 0, color: "var(--text-muted)", fontSize: "15px" } as React.CSSProperties,
};

const cardStyles = {
  card: {
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    padding: "16px 18px",
    transition: "border-color 120ms ease",
  } as React.CSSProperties,
  head: {
    display: "flex",
    alignItems: "flex-start",
    gap: "14px",
  } as React.CSSProperties,
  radio: {
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    border: "2px solid var(--border)",
    marginTop: "2px",
    flexShrink: 0,
  } as React.CSSProperties,
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  } as React.CSSProperties,
  title: {
    fontWeight: 600,
    fontSize: "14px",
  } as React.CSSProperties,
  badge: {
    fontSize: "11px",
    letterSpacing: "0.5px",
    textTransform: "uppercase" as const,
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: "999px",
    padding: "2px 8px",
  } as React.CSSProperties,
  body: {
    margin: "6px 0 0",
    color: "var(--text-muted)",
    fontSize: "13px",
    lineHeight: 1.5,
  } as React.CSSProperties,
  extras: {
    marginTop: "14px",
    paddingTop: "14px",
    borderTop: "1px solid var(--border)",
  } as React.CSSProperties,
  section: {
    display: "flex",
    flexDirection: "column",
  } as React.CSSProperties,
  label: {
    fontSize: "12px",
    color: "var(--text-muted)",
    marginBottom: "6px",
  } as React.CSSProperties,
  row: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  input: {
    flex: "1 1 320px",
    minWidth: 0,
    padding: "8px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    fontSize: "13px",
    outline: "none",
  } as React.CSSProperties,
  testButton: {
    flex: "0 0 auto",
    padding: "8px 14px",
    background: "var(--bg-panel-hover)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    fontSize: "13px",
    cursor: "pointer",
  } as React.CSSProperties,
  scanHint: {
    margin: "0 0 10px",
    fontSize: "12px",
    color: "var(--text-muted)",
  } as React.CSSProperties,
  discoveredBlock: {
    marginBottom: "18px",
  } as React.CSSProperties,
  currentServerBlock: {
    marginBottom: "18px",
  } as React.CSSProperties,
  discoveredList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    marginTop: "8px",
  } as React.CSSProperties,
  recentList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    marginTop: "8px",
    maxHeight: "146px",
    overflowY: "auto" as const,
    paddingRight: "4px",
  } as React.CSSProperties,
  discoveredButton: {
    textAlign: "left" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
    padding: "8px 10px",
    background: "var(--bg-panel-hover)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text)",
    fontSize: "12px",
    cursor: "pointer",
    width: "100%",
  } as React.CSSProperties,
  currentServerButton: {
    borderColor: "var(--success)",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--success) 35%, transparent)",
    width: "100%",
  } as React.CSSProperties,
  serverRowHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  } as React.CSSProperties,
  serverRowTitle: {
    color: "var(--text)",
    fontSize: "12px",
    fontWeight: 600,
  } as React.CSSProperties,
  serverRowUrl: {
    color: "var(--text-muted)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "11px",
  } as React.CSSProperties,
  currentBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    color: "var(--success)",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
  } as React.CSSProperties,
  currentDot: {
    width: "7px",
    height: "7px",
    borderRadius: "999px",
    background: "var(--success)",
  } as React.CSSProperties,
  probeOk: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
  } as React.CSSProperties,
  stateMessage: {
    fontSize: "12px",
    color: "var(--text-muted)",
    lineHeight: 1.4,
  } as React.CSSProperties,
  diagnosticButton: {
    display: "block", marginTop: "6px", color: "inherit", background: "transparent",
    border: "1px solid currentColor", borderRadius: "4px", padding: "3px 6px", cursor: "pointer",
  } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanizeConnectionFailure(reason: Exclude<ConnectionResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "invalid-target": return "Enter a valid Nautilo server address.";
    case "downgrade-confirmation-required": return "This saved HTTPS server cannot be changed to HTTP automatically.";
    case "offline": return "The server is not reachable yet. Check the address and try again.";
    case "incompatible": return "This address did not answer as a compatible Nautilo server.";
    case "wrong-server": return "This is a different Nautilo server.";
    case "identity-changed-again": return "The server identity changed again. Connect again before accepting it.";
    case "stale": return "This connection attempt was replaced. Try again.";
    case "promotion-failed": return "Nautilo could not finish switching servers. Try again to resume safely.";
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* use the isolated document fallback */ }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus(); textarea.select();
  try { return document.execCommand("copy"); }
  catch { return false; }
  finally { textarea.remove(); previous?.focus(); }
}

function labelForServerUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isSameServerUrl(a: string, b: string | null): boolean {
  if (!b) return false;
  try {
    return canonicalServerUrlForCompare(a) === canonicalServerUrlForCompare(b);
  } catch {
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  }
}

function canonicalServerUrlForCompare(url: string): string {
  return new URL(url.trim()).toString().replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
