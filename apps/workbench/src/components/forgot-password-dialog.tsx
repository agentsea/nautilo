import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@nautilo/api-client/browser";
import { HANDLE_RE, HANDLE_INVALID_MESSAGE, normalizeHandle } from "@nautilo/types";
import { apiClient } from "../lib/api";
import { desktopAPI, isDesktop } from "../lib/desktop";
import { useAuth } from "../hooks/use-auth";
import { markPasswordRecoveryCompletionPending } from "../lib/password-recovery-completion";
import { PreAuthShell } from "./pre-auth-shell";

export function isValidResetUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (!(s.startsWith("https://") || /^http:\/\/localhost(?=[:/?#]|$)/.test(s))) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function mapRecoveryApiError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400) {
      return e.message;
    }
    if (e.status === 401 || e.status === 429) {
      return "We couldn't complete the request. Check your details and try again.";
    }
    if (e.status === 403) {
      return "Password reset isn't available from this device. Use the desktop app.";
    }
    if (e.status === 404) {
      return e.message;
    }
    if (e.status === 502 || e.status === 503) {
      return "Could not reach the auth provider; try again.";
    }
    return "We couldn't complete the request. Check your details and try again.";
  }
  return "We couldn't complete the request. Check your details and try again.";
}

const RELAY_POLL_MS = 2000;
/** Server session TTL is 10 min; stop polling a bit earlier. */
const RELAY_POLL_TIMEOUT_MS = 8 * 60 * 1000;

interface Props {
  onClose: () => void;
  onPasswordChanged?: () => void;
  /** Pre-fill Tab A fields (workbench unit tests only). */
  testDefaults?: { handle: string; recoveryCode: string };
}

type Tab = "code" | "url";
type TabAPhase = "form" | "polling" | "ready";

export function ForgotPasswordDialog({ onClose, testDefaults }: Props) {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>("code");
  // M107: identifier is `handle`, not email. Local installs have no
  // SMTP wiring; users are addressed by Logto username (= Nautilo handle).
  const [handle, setHandle] = useState(testDefaults?.handle ?? "");
  const [recoveryCode, setRecoveryCode] = useState(testDefaults?.recoveryCode ?? "");
  const [resetUrl, setResetUrl] = useState("");
  const [clientError, setClientError] = useState("");
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [browserPopupNote, setBrowserPopupNote] = useState(false);
  const [tabAPhase, setTabAPhase] = useState<TabAPhase>("form");
  const [relayEmail, setRelayEmail] = useState("");
  const [relayCode, setRelayCode] = useState("");
  const [relaySession, setRelaySession] = useState<{
    sessionId: string;
    sessionToken: string;
  } | null>(null);
  const codeHandleRef = useRef<HTMLInputElement>(null);
  const urlTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (tab === "code" && tabAPhase === "form") {
      codeHandleRef.current?.focus();
    } else if (tab === "url") {
      urlTextareaRef.current?.focus();
    }
  }, [tab, tabAPhase]);

  const resetTabAFlow = useCallback(() => {
    setTabAPhase("form");
    setRelaySession(null);
    setRelayEmail("");
    setRelayCode("");
  }, []);

  useEffect(() => {
    if (tabAPhase !== "polling" || !relaySession) return;

    const startedAt = Date.now();
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt > RELAY_POLL_TIMEOUT_MS) {
        setServerError("Timed out waiting for the verification code. Try again.");
        resetTabAFlow();
        return;
      }
      try {
        const res = await apiClient.getRecoveryRelayCode(relaySession);
        if (cancelled) return;
        if (res.status === "ready") {
          setRelayCode(res.code);
          setTabAPhase("ready");
        }
      } catch (e) {
        if (cancelled) return;
        setServerError(mapRecoveryApiError(e));
        resetTabAFlow();
      }
    };

    void poll();
    const id = setInterval(() => void poll(), RELAY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tabAPhase, relaySession, resetTabAFlow]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  const validateTabA = useCallback(() => {
    const normalized = normalizeHandle(handle);
    if (!HANDLE_RE.test(normalized)) {
      setClientError(HANDLE_INVALID_MESSAGE);
      return false;
    }
    if (!recoveryCode.trim()) {
      setClientError("Recovery code is required.");
      return false;
    }
    return true;
  }, [handle, recoveryCode]);

  const submitTabA = useCallback(async () => {
    setClientError("");
    setServerError("");
    if (!validateTabA()) return;
    setSubmitting(true);
    try {
      const res = await apiClient.recoverPasswordWithCode({
        handle: normalizeHandle(handle),
        recoveryCode: recoveryCode.trim(),
      });
      setRelayEmail(res.email);
      setRelaySession({ sessionId: res.sessionId, sessionToken: res.sessionToken });

      if (isDesktop && desktopAPI) {
        const openRes = await desktopAPI.auth.openResetUrl(res.resetUrl);
        if (!openRes.ok) {
          setServerError("Could not open the reset URL. Try again.");
          resetTabAFlow();
          return;
        }
      } else {
        window.open(res.resetUrl, "_blank", "noopener,noreferrer");
      }

      setTabAPhase("polling");
    } catch (e) {
      setServerError(mapRecoveryApiError(e));
    } finally {
      setSubmitting(false);
    }
  }, [handle, recoveryCode, validateTabA, resetTabAFlow]);

  const signInAfterReset = useCallback(async () => {
    if (relaySession) {
      markPasswordRecoveryCompletionPending(relaySession);
    }
    onClose();
    await auth.session.signIn();
  }, [auth.session, onClose, relaySession]);

  const submitTabB = useCallback(async () => {
    setClientError("");
    setServerError("");
    setBrowserPopupNote(false);
    const url = resetUrl.trim();
    if (!isValidResetUrl(url)) {
      setClientError("Doesn't look like a reset URL. Paste the full https:// link.");
      return;
    }
    if (isDesktop && desktopAPI) {
      setSubmitting(true);
      try {
        const res = await desktopAPI.auth.openResetUrl(url);
        if (res.ok) {
          onClose();
        } else {
          setServerError("Could not open the reset URL. Try again.");
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    setBrowserPopupNote(true);
  }, [onClose, resetUrl]);

  const inputClass =
    "mt-3 w-full rounded-md border border-border bg-background-element px-3 py-2 text-foreground placeholder:text-foreground-disabled focus:border-border-interactive focus:outline-none";

  return (
    <div onKeyDown={handleKeyDown}>
      <PreAuthShell scrim="modal" title="Reset password" onClose={onClose}>
        <div className="text-left">
          <>
            <div className="mt-4 flex rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => {
                  setTab("code");
                  setClientError("");
                  setServerError("");
                  resetTabAFlow();
                }}
                className={
                  tab === "code"
                    ? "flex-1 rounded px-2 py-1.5 text-sm font-medium bg-background-subtle text-primary"
                    : "flex-1 rounded px-2 py-1.5 text-sm font-medium text-foreground-muted hover:text-primary"
                }
              >
                Use a recovery code
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab("url");
                  setClientError("");
                  setServerError("");
                }}
                className={
                  tab === "url"
                    ? "flex-1 rounded px-2 py-1.5 text-sm font-medium bg-background-subtle text-primary"
                    : "flex-1 rounded px-2 py-1.5 text-sm font-medium text-foreground-muted hover:text-primary"
                }
              >
                I have a reset URL
              </button>
            </div>

            {tab === "code" ? (
              tabAPhase === "ready" ? (
                <div className="mt-4">
                  <p className="text-sm text-foreground-muted">
                    On the Logto page, request a verification code for{" "}
                    <span className="font-medium text-foreground">{relayEmail}</span>, then
                    enter this code and your new password. After Logto saves the password,
                    return here to sign in to Nautilo.
                  </p>
                  <p
                    className="mt-4 rounded-md border border-border bg-background-subtle px-4 py-3 text-center font-mono text-2xl tracking-widest text-foreground"
                    data-testid="recovery-relay-code"
                  >
                    {relayCode}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void signInAfterReset();
                    }}
                    className="mt-5 w-full rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover"
                  >
                    Sign in with new password
                  </button>
                </div>
              ) : tabAPhase === "polling" ? (
                <div className="mt-4">
                  <p className="text-sm text-foreground-muted">
                    Complete the reset on the Logto page opened in your browser. When you
                    request a verification code for{" "}
                    <span className="font-medium text-foreground">{relayEmail}</span>, the
                    code will appear here. The Logto reset tab does not sign you into
                    Nautilo automatically; return here after saving the new password.
                  </p>
                  {(clientError || serverError) && (
                    <p className="mt-2 text-sm text-error">{clientError || serverError}</p>
                  )}
                  <button
                    type="button"
                    disabled={submitting}
                    className="mt-5 w-full rounded-md border border-border px-3 py-2 text-sm text-foreground-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={onClose}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <form
                  className="mt-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitTabA();
                  }}
                >
                  <p className="text-xs text-foreground-dim">
                    Enter your handle and recovery code. Logto will collect your new
                    password; Nautilo will show Logto&apos;s verification code here.
                  </p>
                  <label className="mt-3 block text-xs font-medium text-foreground-muted">
                    Handle
                    <input
                      ref={codeHandleRef}
                      type="text"
                      autoComplete="username"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                      placeholder="e.g. alice"
                      className={inputClass}
                    />
                  </label>
                  <label className="mt-1 block text-xs font-medium text-foreground-muted">
                    Recovery code
                    <input
                      type="text"
                      autoComplete="off"
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  {(clientError || serverError) && (
                    <p className="mt-2 text-sm text-error">{clientError || serverError}</p>
                  )}
                  <button
                    type="submit"
                    disabled={submitting}
                    className="mt-5 w-full rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {submitting ? "Verifying…" : "Continue"}
                  </button>
                </form>
              )
            ) : (
              <div className="mt-4">
                <label className="block text-xs font-medium text-foreground-muted">
                  Paste the reset URL provided by your admin
                  <textarea
                    ref={urlTextareaRef}
                    rows={3}
                    value={resetUrl}
                    onChange={(e) => setResetUrl(e.target.value)}
                    className={`${inputClass} resize-y min-h-[5rem]`}
                  />
                </label>
                {(clientError || serverError) && (
                  <p className="mt-2 text-sm text-error">{clientError || serverError}</p>
                )}
                <button
                  type="button"
                  onClick={() => void submitTabB()}
                  disabled={submitting}
                  className="mt-5 w-full rounded-md bg-primary px-3 py-2 text-sm text-[var(--on-primary)] hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Open
                </button>
                {browserPopupNote ? (
                  <p className="mt-2 text-xs text-foreground-dim">
                    If the page didn&apos;t open, allow popups for this site.
                  </p>
                ) : null}
              </div>
            )}
          </>
        </div>
      </PreAuthShell>
    </div>
  );
}
