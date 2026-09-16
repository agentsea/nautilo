/**
 * Deterministic first-owner claim state machine.
 *
 * This file deliberately knows no browser, React, API-client, storage, timer,
 * credential, claim, prepared-state, handle, PIN, or recovery-code value. The
 * coordinator owns those environment effects and translates their redacted
 * outcomes into these events. In particular, this is the sole future `/claim`
 * execution model: legacy handoff inputs may be normalized at the boundary,
 * but this machine has no legacy-engine fallback state or command.
 */

export const OWNER_CLAIM_PHASES = [
  "capturing",
  "waiting-auth",
  "previewing",
  "new-owner",
  "resume-owner",
  "starting-auth",
  "awaiting-callback",
  "binding",
  "profile",
  "completing",
  "showing-recovery",
  "finalizing",
  "finished",
  "recoverable",
] as const;

export type OwnerClaimPhase = (typeof OWNER_CLAIM_PHASES)[number];

export const OWNER_CLAIM_AUTH_STATES = [
  "unknown",
  "signed-out",
  "signing-in",
  "signed-in",
] as const;

export type OwnerClaimAuthState = (typeof OWNER_CLAIM_AUTH_STATES)[number];

export type OwnerClaimContinuation = "new-owner" | "resume-owner";
export type OwnerClaimFinish = "guide" | "product";
export type OwnerClaimAuthIntent = "signup" | "signin" | null;

export type OwnerClaimRecoverableReason =
  | "capture-unavailable"
  | "capture-invalid"
  | "checkpoint-incomplete"
  | "claim-unavailable"
  | "preview-failed"
  | "authentication-failed"
  | "prepare-failed"
  | "claim-reserved"
  | "bind-failed"
  | "profile-failed"
  | "completion-pending"
  | "completion-failed"
  | "navigation-failed";

export type OwnerClaimRetryTarget =
  | "preview"
  | "binding"
  | "new-owner"
  | "resume-owner"
  | "profile"
  | "completing"
  | "finalizing"
  | null;

/**
 * Deliberately redacted view state. Values that authorize or identify a Human
 * stay in the coordinator and must never be copied into this machine.
 */
export interface OwnerClaimMachineState {
  readonly phase: OwnerClaimPhase;
  readonly auth: OwnerClaimAuthState;
  readonly continuation: OwnerClaimContinuation | null;
  readonly finish: OwnerClaimFinish;
  readonly authIntent: OwnerClaimAuthIntent;
  readonly recoverableReason: OwnerClaimRecoverableReason | null;
  readonly retryTarget: OwnerClaimRetryTarget;
}

export type OwnerClaimCheckpoint =
  | "preview"
  | "awaiting-signup"
  | "awaiting-bind"
  | "profile";

export type OwnerClaimCommand =
  | { readonly kind: "preview-claim" }
  | { readonly kind: "prepare-signup" }
  | { readonly kind: "prepare-resume" }
  | { readonly kind: "launch-logto-signup" }
  | { readonly kind: "launch-logto-signin" }
  | { readonly kind: "sign-out" }
  | { readonly kind: "bind-subject" }
  | { readonly kind: "reobserve-bind" }
  | { readonly kind: "complete-profile" }
  | { readonly kind: "reobserve-completion" }
  | { readonly kind: "navigate-guide" }
  | { readonly kind: "navigate-product" };

export const OWNER_CLAIM_EVENT_TYPES = [
  "capture",
  "terminal-recovery",
  "checkpoint",
  "auth",
  "preview-resolved",
  "preview-failed",
  "begin-signup",
  "begin-resume",
  "switch-account",
  "sign-out-failed",
  "prepared",
  "prepare-failed",
  "callback",
  "bind-resolved",
  "bind-failed",
  "bind-ambiguous",
  "submit-profile",
  "completion-resolved",
  "completion-failed",
  "reobserve-resolved",
  "reobserve-failed",
  "recovery-acknowledged",
  "finalized",
  "finalization-failed",
  "retry",
] as const;

export type OwnerClaimEvent =
  | { readonly type: "capture"; readonly outcome: "captured" | "absent" | "invalid" }
  | { readonly type: "terminal-recovery" }
  | { readonly type: "checkpoint"; readonly checkpoint: OwnerClaimCheckpoint | "incomplete" }
  | { readonly type: "auth"; readonly auth: OwnerClaimAuthState }
  | { readonly type: "preview-resolved"; readonly continuation?: OwnerClaimContinuation }
  | { readonly type: "preview-failed"; readonly reason: "unavailable" | "failed" }
  | { readonly type: "begin-signup" }
  | { readonly type: "begin-resume" }
  | { readonly type: "switch-account" }
  | { readonly type: "sign-out-failed" }
  | { readonly type: "prepared"; readonly intent: Exclude<OwnerClaimAuthIntent, null> }
  | { readonly type: "prepare-failed" }
  | { readonly type: "callback"; readonly outcome: "succeeded" | "failed" }
  | { readonly type: "bind-resolved" }
  | { readonly type: "bind-failed"; readonly reason: "reserved" | "failed" }
  | { readonly type: "bind-ambiguous" }
  | { readonly type: "submit-profile" }
  | { readonly type: "completion-resolved"; readonly outcome: "recovery-ready" | "ambiguous" }
  | { readonly type: "completion-failed" }
  | { readonly type: "reobserve-resolved"; readonly outcome: "recovery-ready" | "pending" }
  | { readonly type: "reobserve-failed" }
  | { readonly type: "recovery-acknowledged" }
  | { readonly type: "finalized" }
  | { readonly type: "finalization-failed" }
  | { readonly type: "retry" };

export type OwnerClaimTransitionDisposition = "applied" | "ignored" | "rejected";

export type OwnerClaimTransitionReason =
  | "event-not-allowed-in-phase"
  | "auth-not-ready"
  | "already-authenticated"
  | "auth-intent-mismatch"
  | "auth-not-signed-in"
  | "retry-not-available";

/**
 * The redacted phase/event contract. Its exhaustive unit matrix is deliberately
 * kept separate from transition implementation so an accidental new fallthrough
 * is caught as a behavior change. Event payload guards may still reject an
 * otherwise allowed Human action (for example, submit-profile while signed out).
 */
export const OWNER_CLAIM_ALLOWED_EVENT_TYPES: Readonly<Record<OwnerClaimPhase, readonly OwnerClaimEvent["type"][]>> = {
  "capturing": ["capture", "terminal-recovery", "checkpoint", "auth"],
  "waiting-auth": ["checkpoint", "auth"],
  "previewing": ["auth", "preview-resolved", "preview-failed"],
  "new-owner": ["auth", "begin-signup", "switch-account", "sign-out-failed"],
  "resume-owner": ["auth", "begin-resume", "switch-account", "sign-out-failed"],
  "starting-auth": ["auth", "prepared", "prepare-failed"],
  "awaiting-callback": ["auth", "callback"],
  "binding": ["auth", "bind-resolved", "bind-failed", "bind-ambiguous"],
  "profile": ["auth", "begin-resume", "switch-account", "sign-out-failed", "submit-profile"],
  "completing": ["auth", "completion-resolved", "completion-failed", "reobserve-resolved", "reobserve-failed"],
  "showing-recovery": ["auth", "recovery-acknowledged"],
  "finalizing": ["auth", "finalized", "finalization-failed"],
  "finished": ["auth"],
  "recoverable": ["auth", "retry"],
};

export interface OwnerClaimTransition {
  readonly state: OwnerClaimMachineState;
  readonly commands: readonly OwnerClaimCommand[];
  readonly disposition: OwnerClaimTransitionDisposition;
  readonly reason?: OwnerClaimTransitionReason;
}

export function createOwnerClaimMachineState(input: {
  auth?: OwnerClaimAuthState;
  finish?: OwnerClaimFinish;
} = {}): OwnerClaimMachineState {
  return {
    phase: "capturing",
    auth: input.auth ?? "unknown",
    continuation: null,
    finish: input.finish ?? "guide",
    authIntent: null,
    recoverableReason: null,
    retryTarget: null,
  };
}

function applied(
  state: OwnerClaimMachineState,
  patch: Partial<OwnerClaimMachineState>,
  commands: readonly OwnerClaimCommand[] = [],
): OwnerClaimTransition {
  return { state: { ...state, ...patch }, commands, disposition: "applied" };
}

function ignored(state: OwnerClaimMachineState): OwnerClaimTransition {
  return {
    state,
    commands: [],
    disposition: "ignored",
    reason: "event-not-allowed-in-phase",
  };
}

function rejected(
  state: OwnerClaimMachineState,
  reason: Exclude<OwnerClaimTransitionReason, "event-not-allowed-in-phase">,
): OwnerClaimTransition {
  return { state, commands: [], disposition: "rejected", reason };
}

function startPreview(state: OwnerClaimMachineState): OwnerClaimTransition {
  if (state.auth === "unknown" || state.auth === "signing-in") {
    return applied(state, {
      phase: "waiting-auth",
      authIntent: null,
      recoverableReason: null,
      retryTarget: null,
    });
  }
  return applied(state, {
    phase: "previewing",
    authIntent: null,
    recoverableReason: null,
    retryTarget: null,
  }, [{ kind: "preview-claim" }]);
}

function startBinding(state: OwnerClaimMachineState): OwnerClaimTransition {
  if (state.auth !== "signed-in") {
    return applied(state, { phase: "awaiting-callback", authIntent: null });
  }
  return applied(state, { phase: "binding", authIntent: null }, [{ kind: "bind-subject" }]);
}

function enterRecoverable(
  state: OwnerClaimMachineState,
  reason: OwnerClaimRecoverableReason,
  retryTarget: OwnerClaimRetryTarget,
): OwnerClaimTransition {
  return applied(state, {
    phase: "recoverable",
    authIntent: null,
    recoverableReason: reason,
    retryTarget,
  });
}

function applyAuth(state: OwnerClaimMachineState, auth: OwnerClaimAuthState): OwnerClaimTransition {
  if (state.auth === auth) return ignored(state);

  const next = { ...state, auth };
  switch (state.phase) {
    case "waiting-auth":
      return startPreview(next);
    case "previewing":
      // A hydrate/logout invalidates the coordinator's in-flight preview. A
      // signing-in observation is not a second signed-out decision and must
      // never issue another preview.
      if (auth === "unknown") return applied(next, { phase: "waiting-auth" });
      return applied(next, {});
    case "awaiting-callback":
      if (auth === "signed-in") return startBinding(next);
      // A full return from Logto reconstructs this durable checkpoint before
      // the browser session has hydrated. If that first observation is
      // signed-out, no callback is active to complete; restore the durable
      // checkpoint's original decision instead of stranding the route on its
      // callback spinner. Active launches move through signing-in first and
      // deliberately do not take this hydration-only branch.
      if (auth === "signed-out" && state.auth === "unknown") {
        return state.continuation === "new-owner"
          ? applied(next, { phase: "new-owner", continuation: "new-owner" })
          : applied(next, { phase: "resume-owner", continuation: "resume-owner" });
      }
      return applied(next, {});
    case "completing":
      // A completed mutation response may be lost as auth changes. Reobserve
      // canonical server truth rather than guessing or replaying a mutation.
      return applied(next, {}, [{ kind: "reobserve-completion" }]);
    case "binding":
      // Binding is not completion. Losing the authenticated subject invalidates
      // that in-flight bind and returns to the durable callback checkpoint;
      // only a later signed-in observation may request a new bind.
      return auth === "signed-in" ? applied(next, {}) : applied(next, { phase: "awaiting-callback" });
    case "profile":
      // A session checkpoint records saved form progress, never an identity
      // authorization. Revalidate the first newly observed signed-in subject
      // through the idempotent bind contract before showing that subject the
      // profile form. Signed-out and unresolved auth remain at the durable
      // profile checkpoint so its explicit recovery UI can still render.
      return auth === "signed-in" ? startBinding(next) : applied(next, {});
    case "new-owner":
    case "resume-owner":
    case "starting-auth":
    case "showing-recovery":
    case "finalizing":
    case "finished":
    case "recoverable":
    case "capturing":
      return applied(next, {});
    default:
      return assertNever(state.phase);
  }
}

function retry(state: OwnerClaimMachineState): OwnerClaimTransition {
  switch (state.retryTarget) {
    case "preview":
      return startPreview(state);
    case "binding":
      return applied(state, {
        phase: "binding",
        authIntent: null,
        recoverableReason: null,
        retryTarget: null,
      }, [{ kind: "reobserve-bind" }]);
    case "new-owner":
      return applied(state, {
        phase: "new-owner",
        authIntent: null,
        recoverableReason: null,
        retryTarget: null,
      });
    case "resume-owner":
      return applied(state, {
        phase: "resume-owner",
        authIntent: null,
        recoverableReason: null,
        retryTarget: null,
      });
    case "completing":
      return applied(state, {
        phase: "completing",
        authIntent: null,
        recoverableReason: null,
        retryTarget: null,
      }, [{ kind: "reobserve-completion" }]);
    case "finalizing":
      return navigate(state);
    case "profile":
      return applied(state, {
        phase: "profile",
        authIntent: null,
        recoverableReason: null,
        retryTarget: null,
      });
    case null:
      return rejected(state, "retry-not-available");
    default:
      return assertNever(state.retryTarget);
  }
}

function navigate(state: OwnerClaimMachineState): OwnerClaimTransition {
  return applied(state, {
    phase: "finalizing",
    authIntent: null,
    recoverableReason: null,
    retryTarget: null,
  }, [{ kind: state.finish === "guide" ? "navigate-guide" : "navigate-product" }]);
}

/**
 * Performs one synchronous, side-effect-free transition. Out-of-phase async
 * completions are explicit ignored transitions; invalid Human intents are
 * explicit rejections. The coordinator attaches operation IDs and drops stale
 * completions before dispatching, while this phase guard remains a second,
 * deterministic safety boundary.
 */
export function transitionOwnerClaim(
  state: OwnerClaimMachineState,
  event: OwnerClaimEvent,
): OwnerClaimTransition {
  switch (event.type) {
    case "capture":
      if (state.phase !== "capturing") return ignored(state);
      if (event.outcome === "captured") {
        return applied(state, { phase: "waiting-auth" });
      }
      return enterRecoverable(
        state,
        event.outcome === "absent" ? "capture-unavailable" : "capture-invalid",
        null,
      );

    case "terminal-recovery":
      if (state.phase !== "capturing") return ignored(state);
      return applied(state, {
        phase: "showing-recovery",
        authIntent: null,
        recoverableReason: null,
        retryTarget: null,
      });

    case "checkpoint":
      if (state.phase !== "capturing" && state.phase !== "waiting-auth") return ignored(state);
      if (event.checkpoint === "incomplete") {
        return enterRecoverable(state, "checkpoint-incomplete", null);
      }
      if (event.checkpoint === "preview") return startPreview(state);
      if (event.checkpoint === "profile") {
        return applied(state, { phase: "profile", authIntent: null });
      }
      return startBinding({
        ...state,
        continuation: event.checkpoint === "awaiting-signup" ? "new-owner" : "resume-owner",
      });

    case "auth":
      return applyAuth(state, event.auth);

    case "preview-resolved": {
      if (state.phase !== "previewing") return ignored(state);
      // Optional continuation is deliberate rollback compatibility with an
      // older server: absent means the legacy new-owner behavior, never a
      // runtime fallback to the old browser implementation.
      if ((event.continuation ?? "new-owner") === "new-owner") {
        return applied(state, {
          phase: "new-owner",
          continuation: "new-owner",
        });
      }
      const resumed = { ...state, continuation: "resume-owner" as const };
      // A fresh preview is not a bind permission. Both signed-out and already
      // signed-in owners must first obtain a fresh, tab-scoped prepared state.
      // The signed-in path then binds directly; it must not launch a redundant
      // Logto ceremony or ask for the reserved handle again.
      return resumed.auth === "signed-in"
        ? applied(resumed, { phase: "starting-auth", authIntent: "signin" }, [{ kind: "prepare-resume" }])
        : applied(resumed, { phase: "resume-owner" });
    }

    case "preview-failed":
      if (state.phase !== "previewing") return ignored(state);
      return enterRecoverable(
        state,
        event.reason === "unavailable" ? "claim-unavailable" : "preview-failed",
        "preview",
      );

    case "begin-signup":
      if (state.phase !== "new-owner") return ignored(state);
      if (state.auth === "unknown" || state.auth === "signing-in") {
        return rejected(state, "auth-not-ready");
      }
      if (state.auth === "signed-in") return rejected(state, "already-authenticated");
      return applied(state, { phase: "starting-auth", authIntent: "signup" }, [{ kind: "prepare-signup" }]);

    case "begin-resume":
      if (state.phase !== "resume-owner" && state.phase !== "profile") return ignored(state);
      if (state.auth === "unknown" || state.auth === "signing-in") {
        return rejected(state, "auth-not-ready");
      }
      if (state.auth === "signed-in") return rejected(state, "already-authenticated");
      return applied(state, { phase: "starting-auth", authIntent: "signin" }, [{ kind: "prepare-resume" }]);

    case "switch-account":
      if (state.phase !== "new-owner" && state.phase !== "resume-owner" && state.phase !== "profile") {
        return ignored(state);
      }
      if (state.auth !== "signed-in") return rejected(state, "auth-not-signed-in");
      // The coordinator delegates the only side effect to the existing Logto
      // auth owner. The phase stays meaningful: after the signed-out
      // observation, new-owner can collect a handle, resume-owner can launch
      // ordinary sign-in, and profile can offer its sign-in continuation.
      return applied(state, {}, [{ kind: "sign-out" }]);

    case "sign-out-failed":
      if (state.phase !== "new-owner" && state.phase !== "resume-owner" && state.phase !== "profile") {
        return ignored(state);
      }
      // The coordinator never guesses that Logto signed the subject out. A
      // failed switch-account effect is visible and retryable from exactly the
      // same Human decision point, with no automatic replay or legacy route.
      return enterRecoverable(state, "authentication-failed", state.phase);

    case "prepared":
      if (state.phase !== "starting-auth") return ignored(state);
      if (state.authIntent !== event.intent) return rejected(state, "auth-intent-mismatch");
      // A tab-scoped handoff always needs fresh server preparation. Once that
      // succeeds, an already authenticated reserved owner can bind the same
      // subject directly instead of starting another OIDC login.
      if (event.intent === "signin" && state.auth === "signed-in") return startBinding(state);
      return applied(state, { phase: "awaiting-callback", authIntent: null }, [{
        kind: event.intent === "signup" ? "launch-logto-signup" : "launch-logto-signin",
      }]);

    case "prepare-failed":
      if (state.phase !== "starting-auth") return ignored(state);
      return enterRecoverable(
        state,
        "prepare-failed",
        state.continuation ?? "new-owner",
      );

    case "callback":
      if (state.phase !== "awaiting-callback") return ignored(state);
      if (event.outcome === "failed") return enterRecoverable(state, "authentication-failed", "resume-owner");
      return state.auth === "signed-in" ? startBinding(state) : applied(state, {});

    case "bind-resolved":
      if (state.phase !== "binding") return ignored(state);
      return applied(state, { phase: "profile", authIntent: null });

    case "bind-failed":
      if (state.phase !== "binding") return ignored(state);
      return enterRecoverable(
        state,
        event.reason === "reserved" ? "claim-reserved" : "bind-failed",
        event.reason === "reserved" ? "resume-owner" : "binding",
      );

    case "bind-ambiguous":
      if (state.phase !== "binding") return ignored(state);
      // `/api/bind-logto-user` is idempotent for the same state/subject. A
      // lost bind response must retry that exact contract—not observe setup
      // completion, which cannot be true until the later profile mutation.
      return applied(state, {}, [{ kind: "reobserve-bind" }]);

    case "submit-profile":
      if (state.phase !== "profile") return ignored(state);
      if (state.auth !== "signed-in") return rejected(state, "auth-not-ready");
      return applied(state, { phase: "completing" }, [{ kind: "complete-profile" }]);

    case "completion-resolved":
      if (state.phase !== "completing") return ignored(state);
      if (event.outcome === "recovery-ready") return applied(state, { phase: "showing-recovery" });
      return applied(state, {}, [{ kind: "reobserve-completion" }]);

    case "completion-failed":
      if (state.phase !== "completing") return ignored(state);
      return enterRecoverable(state, "completion-failed", "completing");

    case "reobserve-resolved":
      if (state.phase !== "completing") return ignored(state);
      if (event.outcome === "recovery-ready") return applied(state, { phase: "showing-recovery" });
      return enterRecoverable(state, "completion-pending", "completing");

    case "reobserve-failed":
      if (state.phase !== "completing") return ignored(state);
      return enterRecoverable(state, "completion-pending", "completing");

    case "recovery-acknowledged":
      if (state.phase !== "showing-recovery") return ignored(state);
      return navigate(state);

    case "finalized":
      if (state.phase !== "finalizing") return ignored(state);
      return applied(state, { phase: "finished", authIntent: null });

    case "finalization-failed":
      if (state.phase !== "finalizing") return ignored(state);
      return enterRecoverable(state, "navigation-failed", "finalizing");

    case "retry":
      if (state.phase !== "recoverable") return ignored(state);
      return retry(state);

    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled owner claim value: ${String(value)}`);
}
