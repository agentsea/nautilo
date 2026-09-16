import type { ReactNode } from "react";
import type { InvitePreview as ApiInvitePreview } from "@nautilo/api-client/browser";
import { ApiError } from "@nautilo/api-client/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiClient } from "../lib/api";
import {
  clearSession,
  readSession,
  writeSession,
} from "../lib/invite-redeem-session";
import { useAuth } from "../hooks/use-auth";
import { Button, FieldRow, TextInput } from "../pages/settings/ui";
import { PreAuthShell } from "../components/pre-auth-shell";
import { roomPath } from "./room-route";
import { HANDLE_RE, HANDLE_INVALID_MESSAGE, normalizeHandle } from "@nautilo/types";

const TOKEN_RE = /^inv_[A-Za-z0-9_-]+$/;

export function validToken(t: string | undefined): t is string {
  return typeof t === "string" && TOKEN_RE.test(t);
}

export type InvitePreview = {
  kind: "server" | "claim";
  displayName: string | null;
};

function mapApiPreview(pv: ApiInvitePreview): InvitePreview {
  const kind: InvitePreview["kind"] =
    pv.kind === "claim" ? "claim" : "server";
  const displayName =
    [pv.targetAgentDisplayName, pv.targetRoomLabel, pv.inviterHandle]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .find((s) => s.length > 0) ?? null;
  return { kind, displayName };
}

export function humanizeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const messages: Record<string, string> = {
      revoked: "This invite has been revoked. Ask for a new link.",
      expired: "This invite has expired. Ask for a new link.",
      used_up: "This invite has no uses left. Ask for a new link.",
      already_completed: "This invite has already been completed.",
      claim_reserved:
        "This owner claim is already linked to another sign-in. Sign out and use the account that started it, or ask an administrator to replace the claim.",
      not_bound: "Your sign-up is not linked to this invite. Start again from the invite link.",
      logto_subject_already_bound:
        "This sign-in already belongs to another Nautilo account. Sign out and use the account created for this invite.",
      target_room_unavailable:
        "The Room selected for this invite is no longer available. Ask an administrator to update the invite.",
      landing_room_unavailable:
        "Nautilo could not find a Room for you. Ask an administrator to create or select one.",
      invite_target_unavailable:
        "The access group selected for this invite is no longer available. Ask an administrator for a new invite.",
      handle_taken: "That handle is already in use. Choose another one.",
    };
    if (messages[err.message]) return messages[err.message];
    if (err.status === 429) return "Too many attempts. Please wait a moment and try again.";
    if (err.status >= 500) return "Something went wrong on our side. Please try again later.";
    if (err.message) return err.message;
  }
  return fallback;
}

function humanizePrepareSignupError(err: unknown): string {
  if (err instanceof ApiError) {
    const { status, message: m } = err;
    if (status === 400 && (m === "invalid_handle" || m === "missing_identifier")) {
      return HANDLE_INVALID_MESSAGE;
    }
    if (status === 400 && m === "invalid_email") {
      // Legacy server still on the email-only branch — surface a clear
      // message so the operator notices the server is pre-M107.
      return "Enter a valid handle (3–30 lowercase letters, digits, or underscores).";
    }
    if (status === 404 || m === "not_found") {
      return "We couldn't find that invite, or it is no longer valid.";
    }
    if (status === 410) {
      return "This invite is no longer valid.";
    }
    if (status === 429) return "Too many attempts. Please wait a moment and try again.";
    if (status >= 500) {
      return "Something went wrong on our side. Please try again later.";
    }
    if (m.length > 0) return m;
  }
  return "Could not start sign-up. Please try again.";
}

type WizardState =
  | { kind: "loading" }
  | { kind: "invalid-token" }
  | { kind: "preview"; preview: InvitePreview }
  | { kind: "already-signed-in"; preview: InvitePreview }
  | { kind: "preparing" }
  | { kind: "binding" }
  | { kind: "profile" }
  | { kind: "completing" }
  | { kind: "success"; recoveryCodes: string[]; landingRoomId: string | null }
  | { kind: "error"; message: string };

const PIN_RE = /^\d{6,8}$/;

interface RedeemHandoff {
  readonly token: string;
  readonly state: string;
  readonly handle: string;
  readonly stage: "preview" | "awaiting-signup" | "awaiting-bind" | "profile";
  readonly startedAt: string;
}

interface RedeemHandoffStore {
  readonly read: () => RedeemHandoff | null;
  readonly write: (handoff: RedeemHandoff) => boolean;
  readonly clear: () => void;
}

const ordinaryInviteHandoff: RedeemHandoffStore = {
  read: () => readSession(),
  write: (handoff) => {
    const stage = handoff.stage;
    if (stage === "preview") return false;
    return writeSession({
      version: 2,
      token: handoff.token,
      state: handoff.state,
      handle: handoff.handle,
      stage,
      startedAt: handoff.startedAt,
    });
  },
  clear: clearSession,
};


function Spinner({ label }: { label: string }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-background p-6">
      <span
        aria-hidden="true"
        className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"
      />
      <p className="text-sm text-foreground-muted">{label}</p>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <PreAuthShell title={title} scrim="page">
      <div className="space-y-4 text-left text-sm text-foreground-muted">{children}</div>
    </PreAuthShell>
  );
}

export function InviteRedeem() {
  const { token: ordinaryTokenParam } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  // Keep the bind callback stable across normal auth-provider renders while
  // always reading its current bearer getter when the callback actually runs.
  const authSessionRef = useRef(auth.session);
  authSessionRef.current = auth.session;
  const handoff = ordinaryInviteHandoff;
  const tokenParam = ordinaryTokenParam;
  const [state, setState] = useState<WizardState>(() =>
    validToken(tokenParam) ? { kind: "loading" } : { kind: "invalid-token" },
  );
  // M107: handle is collected in the preview step (not the profile
  // step) and locked in pre-Logto. Display name + PIN remain in the
  // profile step.
  const [handle, setHandle] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const suppressPreviewBootstrap = useRef(false);

  useEffect(() => {
    suppressPreviewBootstrap.current = false;
  }, [tokenParam]);

  const runBind = useCallback(
    async (opaqueState: string) => {
      setState({ kind: "binding" });
      try {
        // AuthProvider's session getter coalesces acquisition and latches the
        // bearer before returning, so bind cannot race viewer polling.
        const accessToken = await authSessionRef.current.getAccessToken();
        if (!accessToken) {
          setState({
            kind: "error",
            message:
              "Could not read your sign-in session. Refresh and try again.",
          });
          return;
        }
        await apiClient.bindLogtoUser({ state: opaqueState });
        const cur = handoff.read();
        if (cur && tokenParam && cur.token === tokenParam) {
          handoff.write({ ...cur, stage: "profile" });
        }
        suppressPreviewBootstrap.current = true;
        setState({ kind: "profile" });
      } catch (err) {
        suppressPreviewBootstrap.current = false;
        if (err instanceof ApiError && err.status === 422) {
          handoff.clear();
          setState({
            kind: "error",
            message: "This invite has expired or was already used.",
          });
          return;
        }
        setState({
          kind: "error",
          message: humanizeApiError(err, "Could not link your account."),
        });
      }
    },
    [handoff, tokenParam],
  );

  useEffect(() => {
    if (!validToken(tokenParam)) {
      setState({ kind: "invalid-token" });
      return;
    }
    const token = tokenParam;

    // Auth hydration is not a signed-out decision. Starting preview while it
    // is still unknown captures a stale auth closure that can later overwrite
    // a restored signed-in `profile` handoff after a hard refresh.
    if (auth.session.state === "unknown") {
      setState({ kind: "loading" });
      return;
    }

    const storedRaw = handoff.read();
    if (storedRaw && storedRaw.token !== token) {
      handoff.clear();
    }
    const stored = handoff.read();

    if (
      auth.session.state === "signed-in" &&
      stored &&
      stored.token === token &&
      stored.stage === "profile"
    ) {
      // Rehydrate the handle for the read-only display on the profile
      // card. (`writeSession` carries `handle` post-M107.)
      setHandle(stored.handle);
      setState({ kind: "profile" });
      return;
    }

    if (
      auth.session.state === "signed-in" &&
      stored &&
      stored.token === token &&
      (stored.stage === "awaiting-signup" || stored.stage === "awaiting-bind")
    ) {
      setHandle(stored.handle);
      if (stored.stage === "awaiting-signup") {
        handoff.write({ ...stored, stage: "awaiting-bind" });
      }
      void runBind(stored.state);
      return;
    }

    if (
      auth.session.state === "signing-in" &&
      stored &&
      stored.token === token &&
      (stored.stage === "awaiting-signup" || stored.stage === "awaiting-bind")
    ) {
      setHandle(stored.handle);
      setState({ kind: "preparing" });
      return;
    }

    if (suppressPreviewBootstrap.current) {
      return;
    }

    setState({ kind: "loading" });
    const previewRequest = apiClient.previewInvite(token);
    let disposed = false;
    void previewRequest
      .then((p) => {
        if (disposed) return;
        if (!p) {
          setState({
            kind: "error",
            message: "We couldn't find that invite, or it is no longer valid.",
          });
          return;
        }
        const preview = mapApiPreview(p);
        if (auth.session.state === "signed-in") {
          setState({ kind: "already-signed-in", preview });
        } else {
          setState({ kind: "preview", preview });
        }
      })
      .catch((err) => {
        if (disposed) return;
        setState({
          kind: "error",
          message: humanizeApiError(
            err,
            "Could not load the invite.",
          ),
        });
      });
    return () => {
      disposed = true;
    };
  }, [tokenParam, auth.session.state, handoff, runBind]);

  async function onPreviewSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validToken(tokenParam)) return;
    const token = tokenParam;
    const normalizedHandle = normalizeHandle(handle);
    if (!HANDLE_RE.test(normalizedHandle)) {
      setPreviewError(HANDLE_INVALID_MESSAGE);
      return;
    }
    setPreviewError("");
    setState({ kind: "preparing" });
    try {
      const prep = await apiClient.prepareLogtoSignup(token, { handle: normalizedHandle });
      const handoffPersisted = handoff.write({
        token,
        state: prep.state,
        handle: normalizedHandle,
        stage: "awaiting-signup",
        startedAt: new Date().toISOString(),
      });
      if (!handoffPersisted) {
        throw new Error("Could not persist invite handoff");
      }
      suppressPreviewBootstrap.current = true;
      // M107 (Option C): Logto OSS 1.x can't pre-fill the username
      // field via a one-time token (Phase 0 probe), so we skip the OTT
      // entirely and drive the standard sign-in flow with
      // `first_screen=register`. The user types their handle once more
      // on Logto's hosted sign-up page; the wizard preview-step copy
      // warns about this upfront. After OIDC callback the wizard mount
      // effect sees `signed-in` + a stored awaiting-signup session,
      // advances to `runBind`, which unpacks the handle from `state`.
      await auth.session.signIn({
        extraParams: {
          first_screen: "register",
          login_hint: normalizedHandle,
        },
      });
    } catch (err) {
      suppressPreviewBootstrap.current = false;
      setState({
        kind: "error",
        message: humanizePrepareSignupError(err),
      });
    }
  }

  function validateProfile(): boolean {
    const next: Record<string, string> = {};
    const dn = displayName.trim();
    if (dn.length < 1) next.displayName = "Display name is required.";
    // M107: handle is no longer collected in the profile step — it was
    // pinned at bind time. Validate displayName + pin only.
    if (!PIN_RE.test(pin)) next.pin = "PIN must be 6–8 digits.";
    if (pin !== pin2) next.pin2 = "PINs do not match.";
    setProfileErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validToken(tokenParam)) return;
    if (!validateProfile()) return;
    const token = tokenParam;
    setState({ kind: "completing" });
    suppressPreviewBootstrap.current = true;
    try {
      // AuthProvider's session getter has already latched this bearer.
      const accessToken = await auth.session.getAccessToken();
      if (!accessToken) {
        suppressPreviewBootstrap.current = false;
        setState({
          kind: "error",
          message:
            "Could not read your sign-in session. Refresh and try again.",
        });
        return;
      }
      const result = await apiClient.completeInviteProfile(token, {
        displayName: displayName.trim(),
        pin,
      });
      handoff.clear();
      // Completion publishes Group/Room membership transactionally. Refresh
      // whoami before presenting navigation so the Workbench shell cannot
      // briefly render the pre-redemption viewer around the destination Room.
      await auth.refreshViewer();
      setState({
        kind: "success",
        recoveryCodes: result.recoveryCodes,
        landingRoomId: result.landingRoomId,
      });
    } catch (err) {
      suppressPreviewBootstrap.current = false;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setState({
          kind: "error",
          message: humanizeApiError(err, "Could not complete your profile."),
        });
        return;
      }
      setState({
        kind: "error",
        message: humanizeApiError(err, "Could not complete your profile."),
      });
    }
  }

  if (state.kind === "loading" || state.kind === "preparing") {
    return <Spinner label={state.kind === "preparing" ? "Preparing sign-up…" : "Validating invite…"} />;
  }

  if (state.kind === "invalid-token") {
    return (
      <Card title="Invalid invite">
        <p>
          This invite link looks malformed. Ask whoever sent it to share a new one.
        </p>
      </Card>
    );
  }

  if (state.kind === "preview") {
    return (
      <PreAuthShell
        title="You've been invited"
        subtitle={state.preview.displayName ?? undefined}
        scrim="page"
      >
        <form
          className="text-left"
          onSubmit={(e) => { void onPreviewSubmit(e); }}
        >
          <div className="border-t border-border pt-2">
            <FieldRow
              label="Choose a handle"
              htmlFor="invite-handle"
              hint={previewError || HANDLE_INVALID_MESSAGE}
            >
              <TextInput
                id="invite-handle"
                type="text"
                value={handle}
                onChange={(v) => {
                  setHandle(v.toLowerCase());
                  if (previewError) setPreviewError("");
                }}
                placeholder="e.g. alice"
                autoComplete="username"
              />
            </FieldRow>
            <p className="mt-3 text-[11px] text-foreground-muted">
              You'll be asked to type this handle once more on the next screen —
              that's a Logto-side limitation we'll smooth out later. Pick something
              you're happy to use forever; you'll sign in with it from now on.
            </p>
          </div>
          <div className="mt-6 flex justify-end">
            <Button type="submit" variant="primary">
              Continue
            </Button>
          </div>
        </form>
      </PreAuthShell>
    );
  }

  if (state.kind === "already-signed-in") {
    return (
      <Card title="Switch account to continue">
        <p>
          You're already signed in as{" "}
          <span className="font-medium text-foreground">
            {auth.session.identity?.name ?? "your current account"}
          </span>
          . Switching accounts to redeem this invite will sign you out.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            void (async () => {
              await auth.session.signOut();
              handoff.clear();
            })();
          }}
        >
          Sign out and continue
        </Button>
      </Card>
    );
  }

  if (state.kind === "binding") {
    return <Spinner label="Linking your account…" />;
  }

  if (state.kind === "profile") {
    return (
      <PreAuthShell title="Finish your profile" scrim="page">
        <form
          className="text-left"
          onSubmit={(e) => { void onProfileSubmit(e); }}
        >
          <p className="text-xs text-foreground-muted">
            Signed in as <span className="font-mono text-foreground">{handle}</span>.
            Choose how you'll appear and set a PIN.
          </p>
          <div className="mt-4 border-t border-border">
            <FieldRow label="Display name" htmlFor="invite-display-name" hint={profileErrors.displayName}>
              <TextInput
                id="invite-display-name"
                value={displayName}
                onChange={setDisplayName}
                autoComplete="name"
              />
            </FieldRow>
            <FieldRow label="New PIN" htmlFor="invite-pin" hint={profileErrors.pin}>
              <TextInput
                id="invite-pin"
                type="password"
                value={pin}
                onChange={setPin}
                autoComplete="new-password"
                inputMode="numeric"
              />
            </FieldRow>
            <FieldRow label="Confirm PIN" htmlFor="invite-pin2" hint={profileErrors.pin2}>
              <TextInput
                id="invite-pin2"
                type="password"
                value={pin2}
                onChange={setPin2}
                autoComplete="new-password"
                inputMode="numeric"
              />
            </FieldRow>
          </div>
          <div className="mt-6 flex justify-end">
            <Button type="submit" variant="primary">
              Complete setup
            </Button>
          </div>
        </form>
      </PreAuthShell>
    );
  }

  if (state.kind === "completing") {
    return <Spinner label="Setting up your account…" />;
  }

  if (state.kind === "success") {
    return (
      <Card title="Welcome to Nautilo!">
        <p className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-foreground">
          Save these recovery codes somewhere safe. They're shown only once.
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-background-element p-3 font-mono text-xs text-foreground">
          {state.recoveryCodes.join("\n")}
        </pre>
        <Button
          variant="primary"
          onClick={() => {
            void navigate(
              state.landingRoomId ? roomPath(state.landingRoomId) : "/",
              { replace: true },
            );
          }}
        >
          Continue
        </Button>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card title="Something went wrong">
        <p className="text-foreground">{state.message}</p>
        <Button
          variant="secondary"
          onClick={() => {
            handoff.clear();
            window.location.reload();
          }}
        >
          Try again
        </Button>
      </Card>
    );
  }

  return null;
}
