import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAccessChoice, AgentAccessStatus } from "../../../desktop/electron/ready-to-work-contract";
import { desktopAPI, type DesktopReadyToWorkAPI } from "../lib/desktop";

export type DesktopAgentAccessAPI = Required<Pick<DesktopReadyToWorkAPI,
  "getAgentAccess" | "chooseAgentAccess" | "restoreDevelopment" | "onAgentAccessChanged">>;

export function supportsAgentAccess(api: DesktopReadyToWorkAPI | undefined): api is DesktopReadyToWorkAPI & DesktopAgentAccessAPI {
  return !!api && typeof api.getAgentAccess === "function" && typeof api.chooseAgentAccess === "function"
    && typeof api.restoreDevelopment === "function" && typeof api.onAgentAccessChanged === "function";
}

/** Presentation only. Every action and status remains owned by Electron main. */
export function useAgentAccess(api: DesktopReadyToWorkAPI | undefined = desktopAPI?.readyToWork) {
  const supported = supportsAgentAccess(api);
  const [status, setStatus] = useState<AgentAccessStatus | null>(null);
  const [loading, setLoading] = useState(supported);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sequence = useRef(0);
  const context = useRef(0);
  const mounted = useRef(false);
  const mutationPending = useRef(false);
  const read = useRef<{ api: DesktopAgentAccessAPI; queued: boolean; promise: Promise<void> } | null>(null);

  const refresh = useCallback(async () => {
    if (!supportsAgentAccess(api)) return;
    ++sequence.current;
    setLoading(true);
    if (read.current?.api === api) { read.current.queued = true; return read.current.promise; }
    const pending = { api, queued: false, promise: Promise.resolve() };
    read.current = pending;
    pending.promise = Promise.resolve().then(async () => {
      do {
        pending.queued = false;
        const request = sequence.current;
        try {
          const next = await api.getAgentAccess();
          if (mounted.current && read.current === pending && sequence.current === request) { setStatus(next); setError(null); }
        } catch {
          if (mounted.current && read.current === pending && sequence.current === request) { setStatus(null); setError("Current Agent access could not be checked. Try again."); }
        } finally {
          if (mounted.current && read.current === pending && sequence.current === request) setLoading(false);
        }
      } while (pending.queued && mounted.current && read.current === pending);
    }).finally(() => { if (read.current === pending) read.current = null; });
    return pending.promise;
  }, [api]);

  const retire = useCallback(() => {
    mounted.current = false;
    ++context.current;
    ++sequence.current;
    read.current = null;
  }, []);

  useEffect(() => {
    ++context.current;
    mounted.current = true;
    setStatus(null); setError(null); setActionError(null);
    if (!supportsAgentAccess(api)) { setLoading(false); return retire; }
    const changed = () => { void refresh(); };
    const visible = () => { if (document.visibilityState === "visible") changed(); };
    const authChanged = () => { ++context.current; setStatus(null); setActionError(null); changed(); };
    const unsubscribe = api.onAgentAccessChanged(changed);
    window.addEventListener("nautilo:auth-changed", authChanged);
    window.addEventListener("nautilo:uncontained-host-commands-changed", changed);
    document.addEventListener("visibilitychange", visible);
    void refresh();
    return () => {
      retire();
      unsubscribe();
      window.removeEventListener("nautilo:auth-changed", authChanged);
      window.removeEventListener("nautilo:uncontained-host-commands-changed", changed);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api, refresh, retire]);

  const mutate = useCallback(async (work: (current: DesktopAgentAccessAPI) => Promise<AgentAccessStatus>) => {
    if (!supportsAgentAccess(api) || mutationPending.current) return false;
    mutationPending.current = true;
    const request = ++sequence.current;
    const requestContext = context.current;
    setBusy(true); setError(null); setActionError(null);
    try {
      const next = await work(api);
      if (!mounted.current || context.current !== requestContext) return false;
      if (sequence.current === request) { setStatus(next); setLoading(false); }
      return true;
    } catch (cause) {
      if (mounted.current && context.current === requestContext) setActionError(
        cause instanceof Error && /(?:^|: )That PIN is incorrect\.$/.test(cause.message)
          ? "That PIN is incorrect."
          : "Agent access could not be changed. Check its current status and try again.");
      return false;
    } finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [api]);
  const choose = useCallback((choice: AgentAccessChoice, pin?: string, profile?: { profileId: string; profileRevision: number }) => mutate(current => current.chooseAgentAccess({ choice, ...(pin === undefined ? {} : { pin }), ...profile })), [mutate]);
  const restoreDevelopment = useCallback(() => mutate(current => current.restoreDevelopment()), [mutate]);
  return { supported, status, loading, busy, error: actionError ?? error, refresh, choose, restoreDevelopment };
}
