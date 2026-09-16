// D373 / Stack 137 — terminal work surface (xterm.js renderer).
//
// Spike scope (Phase 0, task 0.3): mount an xterm bound to a main-process
// node-pty session over the preload `terminal:*` bridge. Sessions outlive
// the view — unmount disposes the xterm + listeners but NEVER kills the
// PTY (that's the P1 "backgrounding" invariant; only the explicit Kill
// action or app-quit ends a session).
//
// KNOWN spike limitations (→ P1): no scrollback ring buffer, so a full
// remount of a persisted session starts with a blank screen (node-pty has
// no scrollback). Persistent re-parenting of a single xterm instance is
// the P1 fix (1.4).

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  desktopAPI,
  type TerminalController,
  type TerminalSessionInfo,
} from "../lib/desktop";
import { TerminalControlConsentDialog } from "../components/terminal-control-consent-dialog";

interface TerminalSurfaceProps {
  /** Main-owned active-session lifecycle; background renderers make no IPC. */
  activeSession?: boolean;
  /** Attach to an existing session; omit to spawn a fresh one on mount. */
  sessionId?: string;
  /** Lifts the spawned session id to the shell so re-open reuses it. */
  onSession?: (id: string) => void;
  /** Switch the surface to a specific session (drives a remount via the shell). */
  onSelectSession?: (id: string) => void;
  /** Assistant display name for the "… is driving" indicator (P2.2). */
  assistantName?: string;
  onClose: () => void;
}

/** How often the switcher re-lists live sessions (picks up agent-spawned ones). */
const SESSION_POLL_MS = 2000;

type SurfaceStatus = "loading" | "ready" | "ended" | "unsupported" | "error";

export function TerminalSurface({
  activeSession = true,
  sessionId,
  onSession,
  onSelectSession,
  assistantName,
  onClose,
}: TerminalSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;

  const [status, setStatus] = useState<SurfaceStatus>("loading");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // P2.2b single-writer lock owner. The ref mirrors state so the once-mounted
  // xterm input handler can gate keystrokes without re-subscribing.
  const [controller, setControllerState] = useState<TerminalController>("user");
  const controllerRef = useRef<TerminalController>("user");
  const applyController = useCallback((c: TerminalController) => {
    controllerRef.current = c;
    setControllerState(c);
  }, []);
  // P2.2b — agent asked to type while the user holds the lock (a one-click grant).
  const [agentRequested, setAgentRequested] = useState(false);
  const [sandboxed, setSandboxed] = useState(false);
  const [agentControlConsented, setAgentControlConsented] = useState(false);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  const [consentForRequest, setConsentForRequest] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    sessionId ?? null,
  );
  // Multi-terminal switcher — live session pool (polled + refreshed on change).
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const agentName = assistantName ?? "Agent";

  const refreshSessions = useCallback(async () => {
    const api = desktopAPI?.terminal;
    if (!api || !activeSession) return;
    try {
      setSessions(await api.list());
    } catch {
      /* transient; next poll retries */
    }
  }, [activeSession]);

  useEffect(() => {
    if (!activeSession) return;
    const api = desktopAPI?.terminal;
    if (!api) {
      setStatus("unsupported");
      return;
    }
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: { background: "#0b0b0d", foreground: "#e6e6e6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }

    let disposed = false;
    let sid: string | null = sessionId ?? null;
    // A1: subscribe to live output only AFTER any scrollback replay, so the
    // replayed snapshot and the live stream don't overlap/duplicate. Declared
    // here so cleanup can detach it regardless of which path assigns it.
    let offData: () => void = () => {};
    const subscribeData = () => {
      offData = api.onData((evt) => {
        if (evt.sessionId === sid) term.write(evt.chunk);
      });
    };

    const offExit = api.onExit((evt) => {
      if (evt.sessionId === sid) {
        setExitCode(evt.exitCode);
        setStatus("ended");
      }
    });

    // P2.2b — single-writer lock. The host emits the owner on every transfer;
    // we mirror it so the pill/buttons reflect who holds the terminal.
    const offController =
      typeof api.onController === "function"
        ? api.onController((evt) => {
            if (evt.sessionId === sid) applyController(evt.controller);
          })
        : () => {};

    const offRequest =
      typeof api.onRequest === "function"
        ? api.onRequest((evt) => {
            if (evt.sessionId === sid) setAgentRequested(evt.requested);
          })
        : () => {};

    const inputSub = term.onData((data) => {
      // While Genie holds the lock, the user's keystrokes are dropped — they
      // must click "Take control" first (no interleaved bytes on one stdin).
      if (sid && controllerRef.current === "user") void api.write(sid, data);
    });

    void (async () => {
      try {
        if (sid) {
          // Reattach: replay scrollback FIRST, then subscribe to live output.
          const res = await api.attach(sid);
          if (disposed) return;
          if (res.ok) {
            setActiveSessionId(sid);
            applyController(res.info.controller);
            setAgentRequested(res.info.requested);
            setSandboxed(res.info.sandboxed);
            setAgentControlConsented(res.info.agentControlConsented);
            if (res.scrollback.length > 0) term.write(res.scrollback);
            subscribeData();
            await api.resize(sid, term.cols, term.rows);
          } else {
            sid = null; // session died while backgrounded → spawn fresh below
          }
        }
        if (!sid) {
          // Fresh session: subscribe before create so no initial output is missed.
          subscribeData();
          const info = await api.create({ cols: term.cols, rows: term.rows });
          if (disposed) return;
          applyController(info.controller);
          setSandboxed(info.sandboxed);
          setAgentControlConsented(info.agentControlConsented);
          sid = info.id;
          setActiveSessionId(info.id);
          onSessionRef.current?.(info.id);
        }
        if (!disposed) setStatus("ready");
        term.focus();
      } catch (err) {
        // A4: a real spawn/attach failure is an error state, NOT the
        // "only in desktop" (bridge-absent) state handled above.
        if (!disposed) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      }
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* mid-teardown */
      }
      if (sid) void api.resize(sid, term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      inputSub.dispose();
      offData();
      offExit();
      offController();
      offRequest();
      term.dispose();
      // Intentionally NOT killing the PTY — sessions outlive the view.
    };
     
  }, [sessionId, applyController, activeSession]);

  // Keep the switcher list fresh: poll while mounted + refresh on state change.
  useEffect(() => {
    if (!activeSession || !desktopAPI?.terminal) return;
    void refreshSessions();
    const t = setInterval(() => void refreshSessions(), SESSION_POLL_MS);
    return () => clearInterval(t);
  }, [activeSession, refreshSessions]);

  useEffect(() => {
    if (status === "ready") void refreshSessions();
  }, [status, activeSessionId, refreshSessions]);

  const handleSelectSession = useCallback(
    (id: string) => {
      if (id !== activeSessionId) onSelectSession?.(id);
    },
    [activeSessionId, onSelectSession],
  );

  const handleNewSession = useCallback(async () => {
    const api = desktopAPI?.terminal;
    if (!api || !activeSession) return;
    try {
      const info = await api.create({});
      await refreshSessions();
      onSelectSession?.(info.id);
    } catch {
      /* ignore — user can retry */
    }
  }, [activeSession, onSelectSession, refreshSessions]);

  const handleKillTab = useCallback(
    async (id: string) => {
      const api = desktopAPI?.terminal;
      if (!api) return;
      void api.kill(id);
      if (id === activeSessionId) {
        // Killed the visible session: hop to another live one, else close.
        const other = sessions.find((s) => s.id !== id);
        if (other) onSelectSession?.(other.id);
        else onClose();
      } else {
        await refreshSessions();
      }
    },
    [activeSessionId, sessions, onSelectSession, onClose, refreshSessions],
  );

  const handleKill = useCallback(() => {
    const api = desktopAPI?.terminal;
    if (api && activeSessionId) void api.kill(activeSessionId);
    onClose();
  }, [activeSessionId, onClose]);

  const handleKillAll = useCallback(async () => {
    const api = desktopAPI?.terminal;
    if (!api || sessions.length === 0) return;
    const confirmed = window.confirm(
      `Kill all ${sessions.length} terminal ${sessions.length === 1 ? "session" : "sessions"}? Running processes will stop.`,
    );
    if (!confirmed) return;
    await Promise.allSettled(sessions.map((s) => api.kill(s.id)));
    onClose();
  }, [sessions, onClose]);

  const handleTakeControl = useCallback(async () => {
    const api = desktopAPI?.terminal;
    if (!api || !activeSessionId) return;
    try {
      await api.setController(activeSessionId, "user");
    } catch {
      /* session may have closed */
    }
  }, [activeSessionId]);

  const handleLetAgentDrive = useCallback(async (fromRequest = false) => {
    const api = desktopAPI?.terminal;
    if (!api || !activeSessionId) return;
    if (sandboxed || agentControlConsented) {
      try {
        await api.setController(activeSessionId, "agent");
      } catch {
        /* session may have closed */
      }
      return;
    }
    setConsentForRequest(fromRequest);
    setConsentDialogOpen(true);
  }, [activeSessionId, agentControlConsented, sandboxed]);

  const handleConfirmConsent = useCallback(async () => {
    const api = desktopAPI?.terminal;
    if (!api || !activeSessionId) return;
    try {
      const granted = await api.grantAgentControl(activeSessionId);
      if (!granted) return;
      setAgentControlConsented(true);
      setConsentDialogOpen(false);
      setConsentForRequest(false);
    } catch {
      /* session may have closed */
    }
  }, [activeSessionId]);

  const handleCancelConsent = useCallback(async () => {
    const api = desktopAPI?.terminal;
    const sid = activeSessionId;
    const clearsRequest = consentForRequest;
    setConsentDialogOpen(false);
    setConsentForRequest(false);
    if (clearsRequest && api && sid) {
      try {
        await api.clearRequest(sid);
      } catch {
        /* session may have closed */
      }
    }
  }, [activeSessionId, consentForRequest]);

  const handleDismissRequest = useCallback(async () => {
    const api = desktopAPI?.terminal;
    if (!api || !activeSessionId) return;
    try {
      await api.clearRequest(activeSessionId);
    } catch {
      /* session may have closed */
    }
  }, [activeSessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border bg-background-panel px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <span className="font-medium text-foreground">Terminal</span>
          {activeSessionId && <span className="opacity-60">{activeSessionId}</span>}
          {status === "ready" && controller === "agent" && (
            <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              {agentName + " is driving"}
            </span>
          )}
          {status === "ended" && (
            <span className="text-amber-500">session ended (exit {exitCode ?? "?"})</span>
          )}
          {status === "error" && <span className="text-red-500">failed to start</span>}
        </div>
        <div className="flex items-center gap-2">
          {status === "ready" && controller === "agent" && (
            <button
              type="button"
              onClick={() => void handleTakeControl()}
              className="rounded border border-primary/50 bg-background-element px-2 py-0.5 text-xs font-semibold text-foreground hover:bg-[var(--primary-muted)]"
            >
              Take control
            </button>
          )}
          {status === "ready" && controller === "user" && !agentRequested && (
            <button
              type="button"
              onClick={() => void handleLetAgentDrive()}
              className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {"Let " + agentName + " drive"}
            </button>
          )}
          <button
            type="button"
            onClick={handleKill}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Kill
          </button>
          {sessions.length > 1 && (
            <button
              type="button"
              onClick={() => void handleKillAll()}
              className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              Kill all
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Hide terminal surface; sessions keep running"
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Hide
          </button>
        </div>
      </header>

      {status === "ready" && sessions.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-background-panel px-2 py-1">
          {sessions.map((s) => {
            const active = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                className={
                  "group flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs " +
                  (active
                    ? "bg-background-element text-foreground"
                    : "text-foreground-muted hover:bg-background-element/70")
                }
              >
                <button
                  type="button"
                  onClick={() => handleSelectSession(s.id)}
                  className="flex items-center gap-1"
                  title={s.cwd}
                >
                  {s.controller === "agent" && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" title={agentName + " driving"} />
                  )}
                  <span>{s.title || "shell"}</span>
                  <span className="opacity-40">{s.id}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleKillTab(s.id)}
                  className="opacity-0 transition-opacity hover:!opacity-100 group-hover:opacity-60"
                  aria-label={"Close terminal " + s.id}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => void handleNewSession()}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-foreground-muted hover:bg-background-element hover:text-foreground"
            aria-label="New terminal"
            title="New terminal"
          >
            +
          </button>
        </div>
      )}

      {status === "ready" && controller === "user" && agentRequested && (
        <div className="flex items-center justify-between gap-3 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs">
          <span className="flex items-center gap-1.5 text-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            {agentName + " wants to type in this terminal."}
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleLetAgentDrive(true)}
              className="rounded border border-primary/50 bg-background-element px-2 py-0.5 font-semibold text-foreground hover:bg-[var(--primary-muted)]"
            >
              {"Let " + agentName + " drive"}
            </button>
            <button
              type="button"
              onClick={() => void handleDismissRequest()}
              className="rounded px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Dismiss
            </button>
          </span>
        </div>
      )}
      {consentDialogOpen && (
        <TerminalControlConsentDialog
          assistantName={agentName}
          onCancel={handleCancelConsent}
          onConfirm={handleConfirmConsent}
        />
      )}

      {status === "unsupported" ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          The terminal is only available in the Nautilo desktop app.
        </div>
      ) : status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <span className="text-red-500">Could not start the terminal.</span>
          {errorMsg && <span className="max-w-md break-words opacity-70">{errorMsg}</span>}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 bg-[#0b0b0d]">
          <div ref={hostRef} className="absolute inset-0 p-2" />
        </div>
      )}
    </div>
  );
}
