import {
  useCallback,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Button, FieldRow, TextInput } from "../pages/settings/ui";
import { apiClient } from "../lib/api";
import { isDesktop, desktopAPI } from "../lib/desktop";
import { ApiError } from "@nautilo/api-client/browser";
import { useAuth } from "../hooks/use-auth";

export interface ForgotPinDialogProps {
  onClose: () => void;
  onSuccess: (info: { codesRemaining: number }) => void;
  initialPath?: "recovery-code" | "step-up";
}

export function isFreshReauth401(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    (err.message.includes("fresh_reauth_required") ||
      err.message.includes("recently-issued access token"))
  );
}

export function ForgotPinDialog({
  onClose,
  onSuccess,
  initialPath,
}: ForgotPinDialogProps) {
  const auth = useAuth();
  const canStepUp = isDesktop && desktopAPI !== null;

  const [selectedPath, setSelectedPath] = useState<"recovery-code" | "step-up">(
    () =>
      initialPath === "step-up" && canStepUp ? "step-up" : "recovery-code",
  );

  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPinRecovery, setNewPinRecovery] = useState("");
  const [confirmNewPinRecovery, setConfirmNewPinRecovery] = useState("");

  const [stepUpToken, setStepUpToken] = useState<string | null>(null);
  const [newPinStepUp, setNewPinStepUp] = useState("");
  const [confirmNewPinStepUp, setConfirmNewPinStepUp] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stepUpSubmitting, setStepUpSubmitting] = useState(false);
  const [successInfo, setSuccessInfo] = useState<{
    codesRemaining: number;
  } | null>(null);

  const dismissAfterSuccess = useCallback(
    (info: { codesRemaining: number }) => {
      onSuccess(info);
      setSuccessInfo(info);
      window.setTimeout(() => {
        onClose();
      }, 1500);
    },
    [onClose, onSuccess],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting && !stepUpSubmitting) {
        e.preventDefault();
        onClose();
      }
    },
    [onClose, submitting, stepUpSubmitting],
  );

  const validatePinPair = useCallback(
    (pin: string, confirm: string): string | null => {
      if (!/^\d{6,8}$/.test(pin)) {
        return "PIN must be 6–8 digits.";
      }
      if (pin !== confirm) {
        return "New PIN and confirmation do not match.";
      }
      return null;
    },
    [],
  );

  async function onSubmitRecovery(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const pinErr = validatePinPair(newPinRecovery, confirmNewPinRecovery);
    if (pinErr) {
      setError(pinErr);
      return;
    }
    if (!recoveryCode.trim()) {
      setError("Enter your recovery code.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiClient.recoverPin(recoveryCode.trim(), newPinRecovery);
      const codesRemaining = Number(res.codesRemaining ?? 0);
      dismissAfterSuccess({ codesRemaining });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "PIN recovery failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onReauthenticate() {
    if (!desktopAPI) return;
    setError(null);
    setStepUpSubmitting(true);
    try {
      const result = await desktopAPI.auth.stepUp();
      if ("error" in result) {
        return;
      }
      setStepUpToken(result.accessToken);
      auth.latchAccessToken(result.accessToken);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Re-authentication failed.";
      setError(msg);
    } finally {
      setStepUpSubmitting(false);
    }
  }

  async function onSubmitStepUpPin(e: FormEvent) {
    e.preventDefault();
    if (!desktopAPI || !stepUpToken) return;
    setError(null);
    const pinErr = validatePinPair(newPinStepUp, confirmNewPinStepUp);
    if (pinErr) {
      setError(pinErr);
      return;
    }
    setSubmitting(true);
    auth.latchAccessToken(stepUpToken);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await apiClient.recoverPinWithFreshJwt(newPinStepUp);
          dismissAfterSuccess({ codesRemaining: out.codesRemaining });
          return;
        } catch (err) {
          if (!isFreshReauth401(err) || attempt === 1) {
            throw err;
          }
          const result = await desktopAPI.auth.stepUp();
          if ("error" in result) {
            return;
          }
          setStepUpToken(result.accessToken);
          auth.latchAccessToken(result.accessToken);
        }
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "PIN recovery failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-background-panel p-6 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-primary">Reset your PIN</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting || stepUpSubmitting}
            className="rounded p-1 text-foreground-muted hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {successInfo ? (
          <p className="mt-4 text-sm text-foreground-muted" role="status">
            {successInfo.codesRemaining} recovery codes remaining
          </p>
        ) : (
          <>
            <div className="mt-4 space-y-3">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="forgot-pin-path"
                  className="mt-1"
                  checked={selectedPath === "recovery-code"}
                  onChange={() => {
                    setSelectedPath("recovery-code");
                    setError(null);
                  }}
                />
                <span>I have a recovery code</span>
              </label>
              {canStepUp ? (
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="forgot-pin-path"
                    className="mt-1"
                    checked={selectedPath === "step-up"}
                    onChange={() => {
                      setSelectedPath("step-up");
                      setError(null);
                    }}
                  />
                  <span>Verify with my password</span>
                </label>
              ) : null}
            </div>

            {selectedPath === "recovery-code" ? (
              <form className="mt-4 space-y-1" onSubmit={(e) => void onSubmitRecovery(e)}>
                <FieldRow label="Recovery code" htmlFor="forgot-pin-recovery-code">
                  <TextInput
                    id="forgot-pin-recovery-code"
                    value={recoveryCode}
                    onChange={setRecoveryCode}
                    autoComplete="off"
                    disabled={submitting}
                    ariaLabel="PIN recovery code"
                  />
                </FieldRow>
                <FieldRow label="New PIN" htmlFor="forgot-pin-new-recovery">
                  <TextInput
                    id="forgot-pin-new-recovery"
                    type="password"
                    value={newPinRecovery}
                    onChange={setNewPinRecovery}
                    autoComplete="off"
                    inputMode="numeric"
                    disabled={submitting}
                    ariaLabel="New PIN"
                  />
                </FieldRow>
                <FieldRow label="Confirm new PIN" htmlFor="forgot-pin-confirm-recovery">
                  <TextInput
                    id="forgot-pin-confirm-recovery"
                    type="password"
                    value={confirmNewPinRecovery}
                    onChange={setConfirmNewPinRecovery}
                    autoComplete="off"
                    inputMode="numeric"
                    disabled={submitting}
                    ariaLabel="Confirm new PIN"
                  />
                </FieldRow>
                <p className="pt-1 text-xs text-foreground-muted">
                  PIN must be 6–8 digits.
                </p>
                {error ? (
                  <p className="mt-2 text-sm text-error">{error}</p>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={submitting}
                    onClick={onClose}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
                    Submit
                  </Button>
                </div>
              </form>
            ) : (
              <div className="mt-4">
                {!stepUpToken ? (
                  <div className="space-y-3">
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => void onReauthenticate()}
                      loading={stepUpSubmitting}
                      disabled={stepUpSubmitting}
                    >
                      Re-authenticate
                    </Button>
                    {error ? (
                      <p className="text-sm text-error">{error}</p>
                    ) : null}
                  </div>
                ) : (
                  <form className="space-y-1" onSubmit={(e) => void onSubmitStepUpPin(e)}>
                    <FieldRow label="New PIN" htmlFor="forgot-pin-new-stepup">
                      <TextInput
                        id="forgot-pin-new-stepup"
                        type="password"
                        value={newPinStepUp}
                        onChange={setNewPinStepUp}
                        autoComplete="off"
                        inputMode="numeric"
                        disabled={submitting}
                        ariaLabel="New PIN"
                      />
                    </FieldRow>
                    <FieldRow label="Confirm new PIN" htmlFor="forgot-pin-confirm-stepup">
                      <TextInput
                        id="forgot-pin-confirm-stepup"
                        type="password"
                        value={confirmNewPinStepUp}
                        onChange={setConfirmNewPinStepUp}
                        autoComplete="off"
                        inputMode="numeric"
                        disabled={submitting}
                        ariaLabel="Confirm new PIN"
                      />
                    </FieldRow>
                    <p className="pt-1 text-xs text-foreground-muted">
                      PIN must be 6–8 digits.
                    </p>
                    {error ? (
                      <p className="mt-2 text-sm text-error">{error}</p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={submitting}
                        onClick={onClose}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
                        Submit
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
