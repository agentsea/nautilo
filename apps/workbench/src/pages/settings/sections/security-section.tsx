import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Prompt, useLogto } from "@logto/react";
import { Button, SectionCard, StatusPill, FieldRow, TextInput } from "../ui";
import { ForgotPinDialog } from "../../../components/forgot-pin-dialog";
import { useAuth } from "../../../hooks/use-auth";
import { useLogtoResource } from "../../../contexts/auth-mode";
import { apiClient } from "../../../lib/api";
import { buildWorkbenchRedirectUri } from "../../../lib/logto-redirect-uri";
import { isDesktop, desktopAPI } from "../../../lib/desktop";
import { ApiError } from "@nautilo/api-client/browser";
import type { AccountSecurityResponse } from "@nautilo/api-client/browser";

export function SecuritySection() {
  const auth = useAuth();
  const logto = useLogto();
  const { redirectOrigins } = useLogtoResource();

  const [accountSec, setAccountSec] = useState<AccountSecurityResponse | null>(
    null,
  );
  const [secLoading, setSecLoading] = useState(false);
  const [secError, setSecError] = useState<string | null>(null);

  const [pinOpen, setPinOpen] = useState(false);
  const [forgotPinOpen, setForgotPinOpen] = useState(false);
  const [forgotPinInitialPath, setForgotPinInitialPath] = useState<
    "recovery-code" | "step-up" | undefined
  >(undefined);
  const [pinEnrolled, setPinEnrolled] = useState<boolean | null>(null);
  const [pinEnrollmentLoading, setPinEnrollmentLoading] = useState(false);
  const [pinEnrollmentError, setPinEnrollmentError] = useState<string | null>(
    null,
  );
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwMessage, setPwMessage] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);

  const [rcRegenOpen, setRcRegenOpen] = useState(false);
  const [rcSubmitting, setRcSubmitting] = useState(false);
  const [rcError, setRcError] = useState<string | null>(null);
  const [rcPlaintext, setRcPlaintext] = useState<string[] | null>(null);
  const [rcCopyNotice, setRcCopyNotice] = useState<string | null>(null);
  const [rcReauthNeeded, setRcReauthNeeded] = useState(false);
  const [rcReauthMessage, setRcReauthMessage] = useState("");
  const rcCopyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  function clearRcCopyNoticeTimer() {
    if (rcCopyNoticeTimerRef.current) {
      clearTimeout(rcCopyNoticeTimerRef.current);
      rcCopyNoticeTimerRef.current = null;
    }
  }

  useEffect(() => () => clearRcCopyNoticeTimer(), []);

  const loadAccountSecurity = useCallback(async () => {
    if (!auth.viewer.isVerified) {
      setAccountSec(null);
      setSecError(null);
      return;
    }
    setSecLoading(true);
    setSecError(null);
    try {
      const data = await apiClient.getAccountSecurity();
      setAccountSec(data);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not load account security.";
      setSecError(msg);
      setAccountSec(null);
    } finally {
      setSecLoading(false);
    }
  }, [auth.viewer.isVerified]);

  useEffect(() => {
    void loadAccountSecurity();
  }, [loadAccountSecurity]);

  const loadPinEnrollment = useCallback(async () => {
    if (!auth.viewer.isVerified) {
      setPinEnrolled(null);
      setPinEnrollmentError(null);
      setPinEnrollmentLoading(false);
      return;
    }
    setPinEnrollmentLoading(true);
    setPinEnrollmentError(null);
    try {
      const { enrolled } = await apiClient.getPinEnrollment();
      setPinEnrolled(enrolled);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : "Could not load PIN status.";
      setPinEnrollmentError(msg);
      setPinEnrolled(null);
    } finally {
      setPinEnrollmentLoading(false);
    }
  }, [auth.viewer.isVerified]);

  useEffect(() => {
    void loadPinEnrollment();
  }, [loadPinEnrollment]);

  useEffect(() => {
    const onOpenChangePin = () => {
      setPinOpen(true);
    };
    const onOpenRestorePin = () => {
      setForgotPinInitialPath(
        isDesktop && desktopAPI ? "step-up" : "recovery-code",
      );
      setForgotPinOpen(true);
    };
    window.addEventListener("nautilo:open-change-pin", onOpenChangePin);
    window.addEventListener("nautilo:open-restore-pin", onOpenRestorePin);
    return () => {
      window.removeEventListener("nautilo:open-change-pin", onOpenChangePin);
      window.removeEventListener("nautilo:open-restore-pin", onOpenRestorePin);
    };
  }, []);

  async function onSubmitPinChange(e: FormEvent) {
    e.preventDefault();
    setPinError(null);
    setPinMessage(null);
    if (pinEnrolled === null) {
      setPinError("PIN status is still loading — try again in a moment.");
      return;
    }
    if (newPin !== confirmPin) {
      setPinError("New PIN and confirmation do not match.");
      return;
    }
    if (!/^\d{6,8}$/.test(newPin)) {
      setPinError("PIN must be 6–8 digits.");
      return;
    }
    if (pinEnrolled === true && currentPin.length === 0) {
      setPinError("Enter your current PIN to change it.");
      return;
    }
    const wasFirstEnrollment = pinEnrolled === false;
    setPinSubmitting(true);
    try {
      await apiClient.changePin(
        pinEnrolled === false ? { newPin } : { currentPin, newPin },
      );
      setCurrentPin("");
      setNewPin("");
      setConfirmPin("");
      setPinEnrolled(true);
      setPinMessage(wasFirstEnrollment ? "PIN set." : "PIN updated.");
      setPinOpen(false);
      void loadPinEnrollment();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await loadPinEnrollment();
        setPinError(
          "A PIN was enrolled elsewhere. Close this form and try again with your current PIN.",
        );
        return;
      }
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "PIN change failed.";
      setPinError(msg);
    } finally {
      setPinSubmitting(false);
    }
  }

  async function onSubmitPasswordChange(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwMessage(null);
    if (newPw !== confirmPw) {
      setPwError("New password and confirmation do not match.");
      return;
    }
    setPwSubmitting(true);
    try {
      await apiClient.changePassword({
        currentPassword: currentPw,
        newPassword: newPw,
        confirmPassword: confirmPw,
      });
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setPwMessage("Password updated.");
      setPwOpen(false);
      await loadAccountSecurity();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Password change failed.";
      setPwError(msg);
    } finally {
      setPwSubmitting(false);
    }
  }

  async function onConfirmRegenerateRecoveryCodes() {
    setRcError(null);
    clearRcCopyNoticeTimer();
    setRcCopyNotice(null);
    setRcPlaintext(null);
    setRcSubmitting(true);
    try {
      const { recoveryCodes } = await apiClient.regenerateLogtoRecoveryCodes({});
      setRcPlaintext(recoveryCodes);
      setRcRegenOpen(false);
      setRcReauthNeeded(false);
      setRcReauthMessage("");
      await loadAccountSecurity();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        err.message === "fresh_reauth_required"
      ) {
        setRcReauthNeeded(true);
        setRcReauthMessage(
          "Re-authenticate to confirm this is you, then click Regenerate codes again.",
        );
        return;
      }
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not regenerate recovery codes.";
      setRcError(msg);
    } finally {
      setRcSubmitting(false);
    }
  }

  function downloadRecoveryCodes() {
    if (!rcPlaintext?.length) return;
    const blob = new Blob([rcPlaintext.join("\n")], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nautilo-logto-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Fallback when `navigator.clipboard` is missing or rejects (common in embedded WebViews). */
  function copyTextViaHiddenTextarea(text: string): boolean {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
    return ok;
  }

  async function copyRecoveryCodes() {
    if (!rcPlaintext?.length) return;
    setRcError(null);
    clearRcCopyNoticeTimer();
    setRcCopyNotice(null);
    const text = rcPlaintext.join("\n");
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = copyTextViaHiddenTextarea(text);
      }
    } else {
      copied = copyTextViaHiddenTextarea(text);
    }
    if (copied) {
      setRcCopyNotice("Copied to clipboard.");
      rcCopyNoticeTimerRef.current = setTimeout(() => {
        setRcCopyNotice(null);
        rcCopyNoticeTimerRef.current = null;
      }, 2500);
    } else {
      setRcError("Copy failed — select the codes manually or use download.");
    }
  }

  const showLogtoPasswordPanel = auth.viewer.isVerified;
  const accountIdentity =
    auth.session.identity?.email ??
    auth.session.identity?.name ??
    auth.viewer.userIdentity ??
    auth.viewer.label;

  const showPasswordForm = pwOpen || accountSec?.requiresPasswordChange === true;
  const canSubmitPassword =
    currentPw.length > 0 && newPw.length > 0 && confirmPw.length > 0;

  const canSubmitPin =
    !pinEnrollmentLoading &&
    pinEnrolled !== null &&
    newPin.length > 0 &&
    confirmPin.length > 0 &&
    /^\d{6,8}$/.test(newPin) &&
    /^\d{6,8}$/.test(confirmPin) &&
    (pinEnrolled === false || currentPin.length > 0);

  return (
    <SectionCard
      id="security"
      title="Account security"
      description="Your password, recovery codes, and approval PIN."
    >
      {showLogtoPasswordPanel ? (
        <SubSectionCard
          title="Account & password"
          description="Your Logto password and one account recovery-code set."
        >
          {secLoading ? (
            <p className="mt-2 text-xs text-foreground-muted">
              Loading account security…
            </p>
          ) : secError ? (
            <p className="mt-2 text-xs text-error">{secError}</p>
          ) : accountSec?.linkedToLogto ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border/70 bg-background-element px-3 py-2 text-xs">
                <div className="text-foreground-muted">Signed in as</div>
                <div className="mt-0.5 truncate font-medium text-foreground">
                  {accountIdentity}
                </div>
              </div>
              {accountSec.requiresPasswordChange ? (
                <div
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
                  role="status"
                >
                  <p className="font-medium text-foreground">
                    You must set a new password before continuing.
                  </p>
                  {accountSec.passwordChangeReason ? (
                    <p className="mt-1 text-foreground-muted">
                      Reason: {accountSec.passwordChangeReason}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-2">
                {/* M101 Phase 4 — desktop sends users to Logto's hosted Account
                    Center via the embedded auth window so cleartext credentials
                    never traverse Nautilo. The browser path keeps the inline
                    form until M104 retires `/api/account/password/change`. */}
                {isDesktop && desktopAPI ? (
                  (() => {
                    const desk = desktopAPI;
                    return (
                  <div className="space-y-2">
                    {accountSec.requiresPasswordChange ? (
                      <p className="text-xs text-foreground-muted">
                        Open Logto&rsquo;s hosted page to set a new password.
                      </p>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void desk.auth
                          .openAccountPage("/account/password")
                          .then((r) => {
                            if (!r.ok) {
                              setPwError(
                                `Could not open password page: ${r.reason}`,
                              );
                            }
                          });
                      }}
                    >
                      Change password…
                    </Button>
                    <p className="text-xs text-foreground-muted">
                      Tip: Account → Change password… in the menu bar opens the
                      same page.
                    </p>
                    {pwError ? (
                      <p className="text-xs text-error">{pwError}</p>
                    ) : null}
                  </div>
                    );
                  })()
                ) : showPasswordForm ? (
                  <form
                    className="space-y-1"
                    onSubmit={(e) => void onSubmitPasswordChange(e)}
                  >
                    <FieldRow label="Current password" htmlFor="acct-cur-pw">
                      <TextInput
                        id="acct-cur-pw"
                        type="password"
                        value={currentPw}
                        onChange={setCurrentPw}
                        autoComplete="current-password"
                        disabled={pwSubmitting}
                        ariaLabel="Current password"
                      />
                    </FieldRow>
                    <FieldRow label="New password" htmlFor="acct-new-pw">
                      <TextInput
                        id="acct-new-pw"
                        type="password"
                        value={newPw}
                        onChange={setNewPw}
                        autoComplete="new-password"
                        disabled={pwSubmitting}
                        ariaLabel="New password"
                      />
                    </FieldRow>
                    <FieldRow label="Confirm new" htmlFor="acct-confirm-pw">
                      <TextInput
                        id="acct-confirm-pw"
                        type="password"
                        value={confirmPw}
                        onChange={setConfirmPw}
                        autoComplete="new-password"
                        disabled={pwSubmitting}
                        ariaLabel="Confirm new password"
                      />
                    </FieldRow>
                    {pwError ? (
                      <p className="pt-1 text-xs text-error">{pwError}</p>
                    ) : null}
                    {pwMessage ? (
                      <p className="pt-1 text-xs text-foreground-muted">
                        {pwMessage}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2 pt-3">
                      {!accountSec?.requiresPasswordChange ? (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={pwSubmitting}
                          onClick={() => {
                            setPwOpen(false);
                            setPwError(null);
                            setCurrentPw("");
                            setNewPw("");
                            setConfirmPw("");
                          }}
                        >
                          Cancel
                        </Button>
                      ) : null}
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={pwSubmitting || !canSubmitPassword}
                      >
                        {pwSubmitting ? "Updating…" : "Save password"}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setPwOpen(true);
                        setPwError(null);
                        setPwMessage(null);
                      }}
                    >
                      Change password
                    </Button>
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                  Account recovery codes
                </h4>
                <p className="mt-1 text-xs text-foreground-muted">
                  One-time codes for resetting your Logto password or approval
                  PIN from this machine if you are locked out. Store them
                  offline; the server only keeps hashes.
                </p>
                {accountSec.logtoRecoveryCodes ? (
                  <p className="mt-2 text-xs text-foreground">
                    <span className="font-medium">
                      {accountSec.logtoRecoveryCodes.remaining}
                    </span>{" "}
                    unused of {accountSec.logtoRecoveryCodes.total} issued
                    {accountSec.logtoRecoveryCodes.lastGeneratedAt
                      ? ` · last generated ${new Date(
                          accountSec.logtoRecoveryCodes.lastGeneratedAt,
                        ).toLocaleString()}`
                      : ""}
                  </p>
                ) : null}
                {rcError ? (
                  <p className="mt-2 text-xs text-error">{rcError}</p>
                ) : null}
                {rcRegenOpen ? (
                  <div
                    className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
                    role="dialog"
                    aria-label="Confirm recovery code regeneration"
                  >
                    <p>
                      Regenerating invalidates every existing account recovery
                      code immediately. The server accepts a recently issued
                      sign-in, or your approval PIN if enrolled. If you see a
                      re-auth prompt, use Re-authenticate, then click
                      Regenerate codes again.
                    </p>
                    {rcReauthMessage ? (
                      <p className="mt-2 text-foreground-muted">{rcReauthMessage}</p>
                    ) : null}
                    <div className="mt-2 flex flex-col gap-2">
                      {rcReauthNeeded ? (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={rcSubmitting}
                          onClick={() => {
                            void logto.signIn({
                              redirectUri: buildWorkbenchRedirectUri(
                                "/settings/security",
                                window.location.origin,
                                redirectOrigins,
                              ),
                              prompt: [Prompt.Login],
                            });
                          }}
                        >
                          Re-authenticate
                        </Button>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={rcSubmitting}
                          onClick={() => {
                            setRcRegenOpen(false);
                            setRcReauthNeeded(false);
                            setRcReauthMessage("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          disabled={rcSubmitting}
                          onClick={() => void onConfirmRegenerateRecoveryCodes()}
                        >
                          {rcSubmitting ? "Working…" : "Regenerate codes"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={rcSubmitting}
                      onClick={() => {
                        setRcRegenOpen(true);
                        setRcError(null);
                        setRcReauthNeeded(false);
                        setRcReauthMessage("");
                      }}
                    >
                      Generate or regenerate codes
                    </Button>
                  </div>
                )}
                {rcPlaintext && rcPlaintext.length > 0 ? (
                  <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-foreground">
                      Save these codes now — they will not be shown again.
                    </p>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground">
                      {rcPlaintext.join("\n")}
                    </pre>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        ariaLabel="Copy all recovery codes to clipboard"
                        onClick={() => void copyRecoveryCodes()}
                      >
                        Copy all
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={downloadRecoveryCodes}
                      >
                        Download .txt
                      </Button>
                      {rcCopyNotice ? (
                        <span
                          className="text-xs font-medium text-[var(--success)]"
                          role="status"
                          aria-live="polite"
                        >
                          {rcCopyNotice}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <p className="mt-3 text-[11px] text-foreground-muted">
                  Locked out? Use these codes with Forgot password or Forgot PIN.
                  From this computer, the password recovery endpoint is{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                    POST /api/account/password/recover-with-code
                  </code>{" "}
                  on the Nautilo server (local only) with your handle and one
                  recovery code. Use the operator reset CLI from the runbook if
                  you have no codes.
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-foreground-muted">
              This user is not linked to Logto; password is not managed here.
            </p>
          )}
        </SubSectionCard>
      ) : null}

      <SubSectionCard
        title="Approval PIN"
        description="Used for quick local approvals, including prove_it."
      >
        <div className="grid gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={auth.viewer.isVerified ? "ok" : "muted"}>
              {auth.viewer.isVerified ? "ready" : "locked"}
            </StatusPill>
            <span className="text-foreground-muted">
              PIN prompts appear when Nautilo needs to verify identity or confirm
              sensitive actions.
            </span>
          </div>
          <p className="text-xs leading-snug text-foreground-muted">
            This is separate from your Logto password: Logto signs you in, while
            the local PIN keeps fast approval flows lightweight.
          </p>
          {pinMessage ? (
            <p className="text-xs text-foreground-muted">{pinMessage}</p>
          ) : null}
          {pinError ? <p className="text-xs text-error">{pinError}</p> : null}
          {pinEnrollmentError ? (
            <p className="text-xs text-error">{pinEnrollmentError}</p>
          ) : null}
          {pinEnrollmentLoading && pinEnrolled === null && !pinOpen ? (
            <p className="text-xs text-foreground-muted">Checking PIN status…</p>
          ) : null}
          {pinOpen ? (
            <form className="space-y-1" onSubmit={(e) => void onSubmitPinChange(e)}>
              {pinEnrolled === true ? (
                <FieldRow label="Current PIN" htmlFor="approval-current-pin">
                  <TextInput
                    id="approval-current-pin"
                    type="password"
                    value={currentPin}
                    onChange={setCurrentPin}
                    autoComplete="off"
                    inputMode="numeric"
                    disabled={pinSubmitting}
                    ariaLabel="Current approval PIN"
                  />
                </FieldRow>
              ) : pinEnrolled === null ? (
                <p className="text-xs text-foreground-muted">
                  Loading PIN status…
                </p>
              ) : null}
              <FieldRow label="New PIN" htmlFor="approval-new-pin">
                <TextInput
                  id="approval-new-pin"
                  type="password"
                  value={newPin}
                  onChange={setNewPin}
                  autoComplete="off"
                  inputMode="numeric"
                  disabled={pinSubmitting}
                  ariaLabel="New approval PIN"
                />
              </FieldRow>
              <FieldRow label="Confirm new" htmlFor="approval-confirm-pin">
                <TextInput
                  id="approval-confirm-pin"
                  type="password"
                  value={confirmPin}
                  onChange={setConfirmPin}
                  autoComplete="off"
                  inputMode="numeric"
                  disabled={pinSubmitting}
                  ariaLabel="Confirm new approval PIN"
                />
              </FieldRow>
              <p className="pt-1 text-xs text-foreground-muted">
                PINs must be 6-8 digits. Avoid obvious values like repeated
                digits or birthdays.
              </p>
              <div className="flex flex-wrap gap-2 pt-3">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pinSubmitting}
                  onClick={() => {
                    setPinOpen(false);
                    setPinError(null);
                    setCurrentPin("");
                    setNewPin("");
                    setConfirmPin("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={pinSubmitting || !canSubmitPin}
                >
                  {pinSubmitting
                    ? "Saving…"
                    : pinEnrolled === false
                      ? "Save PIN"
                      : "Update PIN"}
                </Button>
              </div>
              {pinEnrolled === true ? (
                <button
                  type="button"
                  className="mt-2 text-xs text-foreground-muted underline-offset-2 hover:underline cursor-pointer"
                  onClick={() => {
                    setForgotPinInitialPath(undefined);
                    setForgotPinOpen(true);
                  }}
                >
                  Forgot PIN?
                </button>
              ) : null}
            </form>
          ) : (
            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  !auth.viewer.isVerified || pinEnrollmentLoading
                }
                title={
                  !auth.viewer.isVerified
                    ? "Verify your identity before changing the approval PIN"
                    : pinEnrolled === false
                      ? "Create your local approval PIN"
                      : "Change your local approval PIN"
                }
                onClick={() => {
                  void loadPinEnrollment();
                  setPinOpen(true);
                  setPinError(null);
                  setPinMessage(null);
                }}
              >
                {pinEnrolled === false
                  ? "Set approval PIN"
                  : pinEnrolled === true
                    ? "Change PIN"
                    : "Set or change PIN"}
              </Button>
              {pinEnrolled === true ? (
                <button
                  type="button"
                  className="mt-2 block text-xs text-foreground-muted underline-offset-2 hover:underline cursor-pointer"
                  onClick={() => {
                    setForgotPinInitialPath(undefined);
                    setForgotPinOpen(true);
                  }}
                >
                  Forgot PIN?
                </button>
              ) : null}
            </div>
          )}

        </div>
      </SubSectionCard>

      {forgotPinOpen ? (
        <ForgotPinDialog
          key={forgotPinInitialPath ?? "default"}
          initialPath={forgotPinInitialPath}
          onClose={() => {
            setForgotPinOpen(false);
            setForgotPinInitialPath(undefined);
          }}
          onSuccess={(info) => {
            setPinMessage(
              `${info.codesRemaining} recovery codes remaining after PIN reset.`,
            );
            void loadPinEnrollment();
          }}
        />
      ) : null}

    </SectionCard>
  );
}

function SubSectionCard({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="mt-4 rounded-lg border border-border/70 bg-background-panel/40 first:mt-0">
      <header className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs text-foreground-muted">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}
