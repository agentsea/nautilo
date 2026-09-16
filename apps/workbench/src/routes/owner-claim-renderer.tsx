/** Passive D508 first-owner renderer. It deliberately owns no API, auth or storage. */
import { useState, type FormEvent, type ReactNode } from "react";
import { HANDLE_INVALID_MESSAGE, HANDLE_RE } from "@nautilo/types";
import { Button, FieldRow, TextInput } from "../pages/settings/ui";
import { PreAuthShell } from "../components/pre-auth-shell";
import {
  type OwnerClaimMachineState,
  type OwnerClaimRecoverableReason,
  type OwnerClaimRetryTarget,
} from "../lib/owner-claim-machine";

const PIN_RE = /^\d{6,8}$/;

function Spinner({ label }: { label: string }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-background p-6">
      <span aria-hidden="true" className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-foreground-muted">{label}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <PreAuthShell title={title} scrim="page"><div className="space-y-4 text-left text-sm text-foreground-muted">{children}</div></PreAuthShell>;
}

function recoveryCopy(reason: OwnerClaimRecoverableReason | null): string {
  switch (reason) {
    case "capture-unavailable":
    case "capture-invalid":
    case "claim-unavailable":
      return "This setup link is missing, expired, or already used. Resume the Nautilo deployment to issue a fresh link.";
    case "checkpoint-incomplete":
      return "This browser cannot safely resume that setup. Resume the Nautilo deployment to issue a fresh link.";
    case "claim-reserved":
      return "This server was reserved by a different account. Sign in with that account, or resume the deployment to issue a new setup link.";
    case "authentication-failed":
      return "Nautilo could not complete the account change. Try again from this exact step.";
    case "completion-pending":
      return "The server has not confirmed setup completion yet. Check its canonical state again; do not submit the profile twice.";
    case "navigation-failed":
      return "Your server is ready, but this browser could not open its destination. Try again.";
    case "preview-failed":
    case "prepare-failed":
    case "bind-failed":
    case "profile-failed":
    case "completion-failed":
      return "Nautilo could not complete that step. Try again; the server remains authoritative.";
    default:
      return "Nautilo could not safely continue this setup.";
  }
}

function retryLabel(target: OwnerClaimRetryTarget): string | null {
  switch (target) {
    case "preview": return "Check setup link";
    case "binding": return "Check account link";
    case "new-owner": return "Try account change again";
    case "resume-owner": return "Sign in to continue";
    case "profile": return "Return to setup";
    case "completing": return "Check server status";
    case "finalizing": return "Open Nautilo";
    case null: return null;
    default: return assertNever(target);
  }
}

export function OwnerClaimRenderer(input: {
  readonly state: OwnerClaimMachineState;
  readonly identityName?: string;
  readonly initialNewOwnerHandle: string;
  readonly recoveryCodes: readonly string[];
  readonly onNewOwner: (handle: string) => void;
  readonly onResume: () => void;
  readonly onSwitchAccount: () => void;
  readonly onProfile: (profile: { displayName: string; pin: string }) => void;
  readonly onRecoveryAcknowledged: () => void;
  readonly onRetry: () => void;
}) {
  const { state } = input;
  if (state.phase === "capturing" || state.phase === "waiting-auth" || state.phase === "previewing") {
    return <Spinner label="Preparing server setup…" />;
  }
  if (state.phase === "new-owner") {
    if (state.auth === "signed-in") {
      return (
        <Card title="Switch account to continue">
          <p>You’re already signed in as <span className="font-medium text-foreground">{input.identityName ?? "your current account"}</span>. Switch accounts to create the first owner.</p>
          <Button variant="primary" onClick={input.onSwitchAccount}>Sign out and continue</Button>
        </Card>
      );
    }
    return <NewOwnerForm initialHandle={input.initialNewOwnerHandle} onSubmit={input.onNewOwner} />;
  }
  if (state.phase === "resume-owner") {
    if (state.auth === "signed-in") {
      return (
        <Card title="Switch account to finish setup">
          <p>This server is reserved for a different account. Switch accounts, then sign in with the account that started this setup.</p>
          <Button variant="primary" onClick={input.onSwitchAccount}>Sign out and continue</Button>
        </Card>
      );
    }
    return (
      <Card title="Sign in to finish setup">
        <p>Finish setup with the account that originally reserved this server. You will not be asked to enter the handle again.</p>
        <Button variant="primary" onClick={input.onResume}>Sign in to finish setup</Button>
      </Card>
    );
  }
  if (state.phase === "starting-auth" || state.phase === "awaiting-callback") return <Spinner label="Opening secure sign-in…" />;
  if (state.phase === "binding") return <Spinner label="Linking your account…" />;
  if (state.phase === "profile") {
    if (state.auth === "unknown" || state.auth === "signing-in") {
      return <Spinner label="Preparing account setup…" />;
    }
    if (state.auth === "signed-out") {
      return (
        <Card title="Sign in to finish setup">
          <p>Your setup progress is saved in this browser session. Sign in with the account you created to continue.</p>
          <Button variant="primary" onClick={input.onResume}>Sign in to finish setup</Button>
        </Card>
      );
    }
    return <ProfileForm onSubmit={input.onProfile} onSwitchAccount={input.onSwitchAccount} />;
  }
  if (state.phase === "completing") return <Spinner label="Setting up your account…" />;
  if (state.phase === "showing-recovery") {
    const hasRecoveryCodes = input.recoveryCodes.length > 0;
    return (
      <Card title="Welcome to Nautilo!">
        {hasRecoveryCodes ? (
          <>
            <p className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-foreground">Save these recovery codes somewhere safe. They’re shown only once.</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-background-element p-3 font-mono text-xs text-foreground">{input.recoveryCodes.join("\n")}</pre>
          </>
        ) : <p className="text-foreground">Your server setup is confirmed, but this browser lost the recovery-code response. {state.finish === "guide" ? "Open the server guide, then create new recovery codes from " : "Open Nautilo, then create new recovery codes from "}<a className="underline hover:text-primary" href="/settings#security">Account security</a>{" before using the server."}</p>}
        <Button variant="primary" onClick={input.onRecoveryAcknowledged}>{state.finish === "guide" ? "Open server guide" : "Open Nautilo"}</Button>
      </Card>
    );
  }
  if (state.phase === "finalizing") return <Spinner label={state.finish === "product" ? "Finalizing your server…" : "Opening your server guide…"} />;
  if (state.phase === "finished") return <Spinner label="Opening Nautilo…" />;
  if (state.phase === "recoverable") {
    const label = retryLabel(state.retryTarget);
    return (
      <Card title="Finish claiming this server">
        <p>{recoveryCopy(state.recoverableReason)}</p>
        {label ? <Button variant="primary" onClick={input.onRetry}>{label}</Button> : null}
      </Card>
    );
  }
  return assertNever(state.phase);
}

function NewOwnerForm({ initialHandle, onSubmit }: { readonly initialHandle: string; readonly onSubmit: (handle: string) => void }) {
  const [handle, setHandle] = useState(initialHandle);
  const [error, setError] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = handle.trim().toLowerCase();
    if (!HANDLE_RE.test(normalized)) {
      setError(HANDLE_INVALID_MESSAGE);
      return;
    }
    onSubmit(normalized);
  };
  return (
    <PreAuthShell title="Set up your Nautilo server" scrim="page">
      <form className="text-left" onSubmit={submit}>
        <div className="border-t border-border pt-2">
          <FieldRow label="Choose a handle" htmlFor="owner-claim-handle" hint="Choose a handle you will use to sign in.">
            <TextInput id="owner-claim-handle" type="text" value={handle} onChange={(value) => { setHandle(value); setError(""); }} placeholder="e.g. alice" autoComplete="username" />
          </FieldRow>
          <p data-owner-handle-error className="mt-2 text-xs text-error">{error}</p>
        </div>
        <div className="mt-6 flex justify-end"><Button type="submit" variant="primary">Continue</Button></div>
      </form>
    </PreAuthShell>
  );
}

function ProfileForm({
  onSubmit,
  onSwitchAccount,
}: {
  readonly onSubmit: (profile: { displayName: string; pin: string }) => void;
  readonly onSwitchAccount: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (displayName.trim().length === 0 || !PIN_RE.test(pin) || pin !== pin2) return;
    onSubmit({ displayName: displayName.trim(), pin });
  };
  return (
    <PreAuthShell title="Create the first owner" scrim="page">
      <form className="text-left" onSubmit={submit}>
        <p className="text-xs text-foreground-muted">Choose how you’ll appear and set a PIN.</p>
        <div className="mt-4 border-t border-border">
          <FieldRow label="Display name" htmlFor="owner-claim-display-name"><TextInput id="owner-claim-display-name" value={displayName} onChange={setDisplayName} autoComplete="name" /></FieldRow>
          <FieldRow label="New PIN" htmlFor="owner-claim-pin" hint="PIN must be 6–8 digits."><TextInput id="owner-claim-pin" type="password" value={pin} onChange={setPin} autoComplete="new-password" inputMode="numeric" /></FieldRow>
          <FieldRow label="Confirm PIN" htmlFor="owner-claim-pin-confirm"><TextInput id="owner-claim-pin-confirm" type="password" value={pin2} onChange={setPin2} autoComplete="new-password" inputMode="numeric" /></FieldRow>
        </div>
        <div className="mt-6 flex items-center justify-between gap-3">
          <Button type="button" variant="secondary" onClick={onSwitchAccount}>Sign out and continue</Button>
          <Button type="submit" variant="primary">Complete setup</Button>
        </div>
      </form>
    </PreAuthShell>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled owner-claim renderer value: ${String(value)}`);
}
