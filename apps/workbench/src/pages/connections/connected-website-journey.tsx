import type { ConnectedWebAccountCreateRequest, ConnectedWebAccountLoginResponse } from "@nautilo/types";
import { ApiError } from "@nautilo/api-client/browser";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { publishConnectedWebAccountRefresh } from "../../adapters/connected-web-account-refresh";
import { setWebsiteConnectionIntentDispatcher, type WebsiteConnectionCompletion, type WebsiteConnectionIntent } from "../../adapters/website-connection-intent";
import { apiClient } from "../../lib/api";
import { WEBSITE_CATALOGUE } from "../../lib/website-catalogue";

type ActiveLogin = ConnectedWebAccountLoginResponse & Readonly<{
  mode: "sign-in" | "view";
  title: string;
  onFinished?: WebsiteConnectionCompletion;
}>;
type Draft = ConnectedWebAccountCreateRequest;
type Retry = Readonly<
  | { kind: "create"; draft: Draft; onFinished?: WebsiteConnectionCompletion }
  | { kind: "reconnect"; accountId: string; onFinished?: WebsiteConnectionCompletion }
  | { kind: "view"; accountId: string; title: string }
>;

function formatExpiry(expiresAt: string, now: number): string {
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes <= 0) return "This sign-in window has expired.";
  if (minutes === 1) return "This sign-in window expires in about 1 minute.";
  return `This sign-in window expires in about ${minutes} minutes.`;
}

function requestForCatalogue(id: string, createAnother = false): Draft | null {
  const website = WEBSITE_CATALOGUE.find((entry) => entry.id === id);
  return website ? { service: website.displayName, origin: website.startUrl, label: website.displayName, createAnother } : null;
}

function requestForCustomUrl(value: string, createAnother = false): Draft | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // The server validates the initial target and canonicalizes durable origin
    // metadata. Keeping the full landing URL here means a pasted deep link
    // opens the exact place the Human intended.
    return { service: parsed.hostname, origin: parsed.toString(), label: parsed.hostname, createAnother };
  } catch {
    return null;
  }
}

function providerSetupMessage(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 503) return null;
  if (error.message === "browser_use_api_key_required") {
    return "Browser Use API key required. Add one in API settings before connecting a website.";
  }
  if (error.message === "browser_use_api_key_invalid") {
    return "Browser Use API key needs attention. Check it in API settings before connecting a website.";
  }
  return null;
}

function authenticationIncomplete(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 409
    && error.message === "connected_web_account_authentication_incomplete";
}

/** Mounted once in the shell so every entry point reaches the same protected journey. */
export function ConnectedWebsiteJourney() {
  const [activeLogin, setActiveLogin] = useState<ActiveLogin | null>(null);
  const activeLoginRef = useRef<ActiveLogin | null>(null);
  const mountedRef = useRef(true);
  const launchGenerationRef = useRef(0);
  const launchInFlightRef = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [providerSetupError, setProviderSetupError] = useState(false);
  const [retry, setRetry] = useState<Retry | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());

  const setLogin = useCallback((next: ActiveLogin | null) => {
    activeLoginRef.current = next;
    setActiveLogin(next);
  }, []);

  useEffect(() => () => {
    // A provider can finish creating a browser after this shell is gone. Mark
    // its response stale before React tears down the remaining effects so the
    // launch path stops it rather than reviving a dead UI with a live browser.
    mountedRef.current = false;
    launchGenerationRef.current += 1;
  }, []);

  const discardLateLogin = useCallback((login: ActiveLogin) => {
    const cleanup = login.mode === "view"
      ? apiClient.closeConnectedWebAccountPage(login.account.id)
      : login.createdNewAccount
        ? apiClient.disconnectConnectedWebAccount(login.account.id)
        : apiClient.cancelConnectedWebAccountLogin(login.account.id);
    void cleanup
      .then(publishConnectedWebAccountRefresh)
      .catch(() => undefined);
  }, []);

  const begin = useCallback(async (next: Draft, onFinished?: WebsiteConnectionCompletion) => {
    if (launchInFlightRef.current || activeLoginRef.current) return;
    const generation = ++launchGenerationRef.current;
    launchInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    setProviderSetupError(false);
    setDraft(next);
    setRetry({ kind: "create", draft: next, ...(onFinished ? { onFinished } : {}) });
    try {
      const created = await apiClient.createConnectedWebAccount(next satisfies ConnectedWebAccountCreateRequest);
      if (!mountedRef.current || generation !== launchGenerationRef.current) {
        discardLateLogin({ ...created, mode: "sign-in", title: created.account.label, ...(onFinished ? { onFinished } : {}) });
        return;
      }
      setDraft(null);
      setRetry(null);
      setLogin({ ...created, mode: "sign-in", title: created.account.label, ...(onFinished ? { onFinished } : {}) });
      publishConnectedWebAccountRefresh();
    } catch (caught) {
      if (mountedRef.current && generation === launchGenerationRef.current) {
        const setupMessage = providerSetupMessage(caught);
        if (setupMessage) {
          setDraft(null);
          setRetry(null);
          setProviderSetupError(true);
          setError(setupMessage);
        } else {
          setError("We couldn’t open a protected sign-in window. Try again.");
        }
      }
    } finally {
      if (generation === launchGenerationRef.current) {
        launchInFlightRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    }
  }, [discardLateLogin, setLogin]);

  const reconnect = useCallback(async (accountId: string, onFinished?: WebsiteConnectionCompletion) => {
    if (launchInFlightRef.current || activeLoginRef.current) return;
    const generation = ++launchGenerationRef.current;
    launchInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    setProviderSetupError(false);
    setDraft(null);
    setRetry({ kind: "reconnect", accountId, ...(onFinished ? { onFinished } : {}) });
    try {
      const reconnected = await apiClient.reconnectConnectedWebAccount(accountId);
      if (!mountedRef.current || generation !== launchGenerationRef.current) {
        discardLateLogin({ ...reconnected, mode: "sign-in", title: reconnected.account.label, ...(onFinished ? { onFinished } : {}) });
        return;
      }
      setLogin({ ...reconnected, mode: "sign-in", title: reconnected.account.label, ...(onFinished ? { onFinished } : {}) });
      setRetry(null);
      publishConnectedWebAccountRefresh();
    } catch (caught) {
      if (mountedRef.current && generation === launchGenerationRef.current) {
        const setupMessage = providerSetupMessage(caught);
        if (setupMessage) {
          setRetry(null);
          setProviderSetupError(true);
          setError(setupMessage);
        } else {
          setError("We couldn’t continue sign-in. Try again.");
        }
      }
    } finally {
      if (generation === launchGenerationRef.current) {
        launchInFlightRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    }
  }, [discardLateLogin, setLogin]);

  const view = useCallback(async (accountId: string, title: string) => {
    if (launchInFlightRef.current || activeLoginRef.current) return;
    const generation = ++launchGenerationRef.current;
    launchInFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    setProviderSetupError(false);
    setDraft(null);
    setRetry({ kind: "view", accountId, title });
    try {
      const opened = await apiClient.openConnectedWebAccountPage(accountId);
      const active: ActiveLogin = { ...opened, mode: "view", title };
      if (!mountedRef.current || generation !== launchGenerationRef.current) {
        discardLateLogin(active);
        return;
      }
      setLogin(active);
      setRetry(null);
    } catch (caught) {
      if (mountedRef.current && generation === launchGenerationRef.current) {
        const setupMessage = providerSetupMessage(caught);
        if (setupMessage) {
          setRetry(null);
          setProviderSetupError(true);
          setError(setupMessage);
        } else {
          setError("We couldn’t open that protected page. Try again.");
        }
      }
    } finally {
      if (generation === launchGenerationRef.current) {
        launchInFlightRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    }
  }, [discardLateLogin, setLogin]);

  useEffect(() => {
    const dispatch = (intent: WebsiteConnectionIntent) => {
      if (intent.kind === "reconnect") {
        void reconnect(intent.accountId, intent.onFinished);
        return;
      }
      if (intent.kind === "view") {
        void view(intent.accountId, intent.title);
        return;
      }
      if (intent.kind === "catalogue") {
        const next = requestForCatalogue(intent.websiteId, intent.createAnother);
        if (next) void begin(next, intent.onFinished);
        return;
      }
      const next = requestForCustomUrl(intent.url, intent.createAnother);
      setError(null);
      setProviderSetupError(false);
      setRetry(null);
      if (next) {
        void begin(next, intent.onFinished);
      } else {
        setCustomUrl(intent.url);
        setDraft({ service: "", origin: "", label: "", createAnother: Boolean(intent.createAnother) });
      }
    };
    setWebsiteConnectionIntentDispatcher(dispatch);
    return () => setWebsiteConnectionIntentDispatcher(null);
  }, [begin, reconnect, view]);

  useEffect(() => {
    if (!activeLogin) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [activeLogin]);

  useEffect(() => () => {
    const active = activeLoginRef.current;
    if (!active) return;
    const cleanup = active.mode === "view"
      ? apiClient.closeConnectedWebAccountPage(active.account.id)
      : active.createdNewAccount
        ? apiClient.disconnectConnectedWebAccount(active.account.id)
        : apiClient.cancelConnectedWebAccountLogin(active.account.id);
    void cleanup.then(publishConnectedWebAccountRefresh).catch(() => undefined);
  }, []);

  const cancel = useCallback(async () => {
    launchGenerationRef.current += 1;
    launchInFlightRef.current = false;
    const active = activeLoginRef.current;
    const onFinished = active?.onFinished ?? (retry?.kind !== "view" ? retry?.onFinished : undefined);
    setLogin(null);
    setDraft(null);
    setError(null);
    setProviderSetupError(false);
    setRetry(null);
    if (!active) {
      onFinished?.("cancelled");
      return;
    }
    try {
      if (active.mode === "view") await apiClient.closeConnectedWebAccountPage(active.account.id);
      else if (active.createdNewAccount) await apiClient.disconnectConnectedWebAccount(active.account.id);
      else await apiClient.cancelConnectedWebAccountLogin(active.account.id);
    } catch {
      // Closing the view must not pretend cleanup succeeded; the refreshed card carries recovery state.
    } finally {
      publishConnectedWebAccountRefresh();
      onFinished?.("cancelled");
    }
  }, [retry, setLogin]);

  const finish = useCallback(async () => {
    const active = activeLoginRef.current;
    if (!active) return;
    setSubmitting(true);
    setError(null);
    setProviderSetupError(false);
    try {
      if (active.mode === "view") await apiClient.closeConnectedWebAccountPage(active.account.id);
      else await apiClient.finishConnectedWebAccount(active.account.id);
      setLogin(null);
      publishConnectedWebAccountRefresh();
      if (active.mode === "sign-in") active.onFinished?.("done");
    } catch (cause) {
      setError(active.mode === "view"
        ? "We couldn’t close that protected page yet. Try Close again."
        : authenticationIncomplete(cause)
          ? "Sign-in isn’t complete yet. Finish the website login, MFA, or CAPTCHA in this protected window, then choose Done."
          : "We couldn’t finish sign-in yet. Complete the website’s checks, then try Done again.");
    } finally {
      setSubmitting(false);
    }
  }, [setLogin]);

  const submitCustom = useCallback((event: FormEvent) => {
    event.preventDefault();
    const next = requestForCustomUrl(customUrl, draft?.createAnother);
    if (!next) {
      setError("Enter a complete http or https website address.");
      setProviderSetupError(false);
      setRetry(null);
      return;
    }
    void begin(next);
  }, [begin, customUrl, draft?.createAnother]);

  const retryFailedRequest = useCallback(() => {
    if (!retry) return;
    if (retry.kind === "create") void begin(retry.draft, retry.onFinished);
    else if (retry.kind === "reconnect") void reconnect(retry.accountId, retry.onFinished);
    else void view(retry.accountId, retry.title);
  }, [begin, reconnect, retry, view]);

  const pendingLaunch = !activeLogin && retry && submitting ? retry : null;
  const pendingTitle = pendingLaunch?.kind === "view"
    ? pendingLaunch.title
    : pendingLaunch?.kind === "create"
      ? pendingLaunch.draft.label
      : null;
  if (!activeLogin && !draft && !error && !pendingLaunch) return null;
  const isLive = activeLogin !== null;
  const isViewing = activeLogin?.mode === "view";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="connected-website-login-title">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background-panel shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id="connected-website-login-title" className="text-base font-semibold text-foreground">{isLive ? isViewing ? `Viewing ${activeLogin.title}` : `Sign in to ${activeLogin.account.label}` : pendingLaunch ? pendingTitle ? `Opening ${pendingTitle}` : "Opening sign-in" : providerSetupError ? "Browser Use setup required" : "Connect a website"}</h2>
            <p className="mt-1 text-sm text-foreground-muted">{isLive ? isViewing ? "This is a protected signed-in browser. Close it when you are finished viewing this page." : "Sign in directly in this protected window. Complete any verification the website asks for, then choose Done." : pendingLaunch ? "Starting the protected browser…" : providerSetupError ? "Website connections need Browser Use before Nautilo can open a protected session." : "Enter the website you want to connect."}</p>
          </div>
          <button type="button" onClick={() => void (isViewing ? finish() : cancel())} className="rounded px-2 py-1 text-sm text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground" aria-label={isViewing ? "Close protected page" : providerSetupError ? "Close Browser Use setup message" : pendingLaunch?.kind === "view" ? "Cancel opening protected page" : "Cancel website sign-in"}>{isViewing || providerSetupError ? "Close" : "Cancel"}</button>
        </header>
        {error ? <p className={`mx-5 mt-4 rounded-md border px-3 py-2 text-sm ${providerSetupError ? "border-[var(--warning)]/40 bg-[var(--warning)]/5 text-foreground" : "border-[var(--error)]/40 bg-[var(--error)]/10 text-[var(--error)]"}`} role={providerSetupError ? "status" : "alert"}>{error}</p> : null}
        {providerSetupError ? <div className="p-5">
          <p className="text-sm text-foreground-muted">Once the key is ready, connect the site once. After that, simply ask your Genie to use the website and it can work through your saved signed-in account without asking for your password in chat.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => void cancel()} className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-[var(--primary-muted)]">Close</button>
            <Link to="/admin#provider-credentials" onClick={() => void cancel()} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-[var(--on-primary)]">Open API settings</Link>
          </div>
        </div> : isLive ? <>
          <div className="min-h-[420px] flex-1 bg-black">
            <iframe title={isViewing ? `Protected page for ${activeLogin.title}` : `Protected sign-in for ${activeLogin.account.label}`} src={activeLogin.login.liveViewUrl} className="h-full min-h-[420px] w-full border-0" allow="autoplay; clipboard-read; clipboard-write; fullscreen" referrerPolicy="no-referrer" />
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
            <p className="text-xs text-foreground-muted" role="status">{formatExpiry(activeLogin.login.expiresAt, now)}</p>
            <div className="flex gap-2">{isViewing ? <button type="button" disabled={submitting} onClick={() => void finish()} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-[var(--on-primary)] disabled:opacity-60">{submitting ? "Closing…" : "Close"}</button> : <><button type="button" onClick={() => void cancel()} className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-[var(--primary-muted)]">Cancel</button><button type="button" disabled={submitting} onClick={() => void finish()} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-[var(--on-primary)] disabled:opacity-60">{submitting ? "Finishing…" : "Done"}</button></>}</div>
          </footer>
        </> : pendingLaunch ? <div className="p-5"><p className="text-sm text-foreground-muted" role="status">{pendingLaunch.kind === "view" ? "Opening the protected page. This can take a few moments." : "Opening the protected sign-in window. This can take a few moments."}</p><div className="mt-4 flex justify-end"><button type="button" onClick={() => void cancel()} className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-[var(--primary-muted)]">Cancel</button></div></div> : retry ? <div className="p-5"><p className="text-sm text-foreground-muted">Your connection has not changed. You can retry the same sign-in request or close this window.</p><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => void cancel()} className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-[var(--primary-muted)]">Close</button><button type="button" disabled={submitting} onClick={retryFailedRequest} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-[var(--on-primary)] disabled:opacity-60">{submitting ? "Trying again…" : "Try again"}</button></div></div> : <form onSubmit={submitCustom} className="p-5">
          <label className="block text-sm font-medium text-foreground" htmlFor="global-connect-website-url">Website address</label>
          <input id="global-connect-website-url" autoFocus type="url" inputMode="url" value={customUrl} onInput={(event) => setCustomUrl(event.currentTarget.value)} placeholder="https://example.com" className="mt-2 w-full rounded-md border border-border bg-background-element px-3 py-2 text-sm text-foreground outline-none focus:border-primary" />
          <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => void cancel()} className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-[var(--primary-muted)]">Cancel</button><button type="submit" disabled={submitting} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-[var(--on-primary)] disabled:opacity-60">{submitting ? "Opening…" : "Continue"}</button></div>
        </form>}
      </div>
    </div>
  );
}
