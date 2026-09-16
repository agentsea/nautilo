/**
 * Native invite enrollment is a ceremony, not a collection of screen-local
 * booleans.  This module deliberately contains no token, Logto state, PIN,
 * access token, or recovery code.  Those values belong to the bounded secure
 * handoff introduced alongside this reducer; renderers only receive opaque
 * ceremony references and safe preview/destination data.
 */

export type CeremonyRef = Readonly<{
  /** Monotonically increasing per intake.  Async work must echo this value. */
  generation: number;
  /** Stable ID derived from the normalized, exact invite server URL. */
  serverId: string;
  /** Opaque identifier for diagnostics/custody, never an invite bearer token. */
  ceremonyId: string;
}>;

export type InvitePreview = Readonly<{
  inviterHandle: string | null;
  targetRoomLabel: string | null;
  expiresAt: string | null;
}>;

export type FailureCode =
  | "invalid-locator"
  | "server-unreachable"
  | "server-mismatch"
  | "invalid-request"
  | "authentication-required"
  | "invite-not-found"
  | "invite-already-redeemed"
  | "invite-expired"
  | "invalid-ceremony"
  | "rate-limited"
  | "server-unavailable"
  | "offline"
  | "auth-cancelled"
  | "interrupted";

/** A route failure whose exact code is safe to use for recovery selection. */
export type ApiFailure = Readonly<{
  status: number;
  errorCode?: string;
}>;

/** Local transport/interruption failures or an API envelope from the client. */
export type CeremonyFailure = FailureCode | ApiFailure;

export type RecoveryAction =
  | "enter-full-invite-url"
  | "verify-server"
  | "edit-handle"
  | "edit-profile"
  | "sign-in-again"
  | "request-new-invite"
  | "wait-and-retry"
  | "retry"
  | "resume"
  | "start-over";

export type RetryStage =
  | "probe-server"
  | "activate-server"
  | "preview"
  | "prepare"
  | "authenticate"
  | "bind"
  | "complete-profile";

/** Safe, persisted stage name used to rehydrate after the external auth hop. */
export type ResumableCeremonyStage = "preview" | "external-auth" | "binding" | "profile";

type BaseState = Readonly<{ ref: CeremonyRef }>;

export type InviteCeremonyState =
  | Readonly<{ kind: "awaiting-locator"; generation: number }>
  | Readonly<{
      kind: "invalid-locator";
      generation: number;
      recovery: "enter-full-invite-url";
    }>
  | (BaseState & Readonly<{ kind: "probing-server"; serverUrl: string }> )
  | (BaseState & Readonly<{ kind: "confirm-server"; serverUrl: string }> )
  | (BaseState &
      Readonly<{
        kind: "activating-server";
        serverUrl: string;
        operation: "add" | "switch";
      }>)
  | (BaseState & Readonly<{ kind: "previewing"; serverUrl: string }> )
  | (BaseState &
      Readonly<{
        kind: "preview";
        serverUrl: string;
        preview: InvitePreview;
      }>)
  | (BaseState &
      Readonly<{
        kind: "signed-in-boundary";
        serverUrl: string;
        preview: InvitePreview;
      }>)
  | (BaseState & Readonly<{ kind: "preparing"; serverUrl: string; preview: InvitePreview }> )
  | (BaseState & Readonly<{ kind: "external-auth"; serverUrl: string; preview: InvitePreview }> )
  | (BaseState & Readonly<{ kind: "binding"; serverUrl: string; preview: InvitePreview }> )
  | (BaseState &
      Readonly<{
        kind: "profile";
        serverUrl: string;
        /** Safe for display; the actual value remains in the secure handoff. */
        handleReady: true;
      }>)
  | (BaseState & Readonly<{ kind: "completing-profile"; serverUrl: string }> )
  | (BaseState &
      Readonly<{
        kind: "recovery-acknowledgement";
        serverUrl: string;
        /** Recovery material is held by a one-time secure presentation seam. */
        recoveryMaterialAvailable: true;
        landingRoomId: string | null;
      }>)
  | (BaseState &
      Readonly<{
        kind: "success";
        landingRoomId: string | null;
      }>)
  | (BaseState &
      Readonly<{
        kind: "failure";
        serverUrl: string | null;
        code: FailureCode;
        recovery: RecoveryAction;
        retryStage: RetryStage | null;
        /** Preserves the exact add/switch retry, rather than guessing. */
        activationOperation: "add" | "switch" | null;
        /** Safe preview retained only for choose-another-handle recovery. */
        resumePreview: InvitePreview | null;
      }>)
  | (BaseState & Readonly<{
      kind: "cancelled";
      serverUrl: string;
      /** Keep-current returns to the existing signed-in app, never setup. */
      destination?: "app" | "add-server";
    }> );

export const initialInviteCeremonyState: InviteCeremonyState = {
  kind: "awaiting-locator",
  generation: 0,
};

type AsyncAction = Readonly<{ ref: CeremonyRef }>;

export type InviteCeremonyAction =
  | Readonly<{
      type: "locator.accepted";
      ref: CeremonyRef;
      serverUrl: string;
    }>
  | Readonly<{ type: "locator.rejected"; generation: number }>
  | (AsyncAction &
      Readonly<{
        type: "server.probe.succeeded";
        serverUrl: string;
        knownServer: boolean;
        alreadyActive: boolean;
      }>)
  | (AsyncAction & Readonly<{ type: "server.probe.failed"; failure: CeremonyFailure }>)
  | (AsyncAction & Readonly<{ type: "server.add.requested" }>)
  | (AsyncAction & Readonly<{ type: "server.switch.requested" }>)
  | (AsyncAction & Readonly<{ type: "server.activation.succeeded" }>)
  | (AsyncAction & Readonly<{ type: "server.activation.failed"; failure: CeremonyFailure }>)
  | (AsyncAction & Readonly<{ type: "preview.succeeded"; preview: InvitePreview; signedIn: boolean }>)
  | (AsyncAction & Readonly<{ type: "preview.failed"; failure: CeremonyFailure }>)
  | (AsyncAction & Readonly<{ type: "account.keep-current" }>)
  | (AsyncAction & Readonly<{ type: "account.switched" }>)
  | (AsyncAction & Readonly<{ type: "prepare.requested" }>)
  | (AsyncAction & Readonly<{ type: "prepare.succeeded" }>)
  | (AsyncAction & Readonly<{ type: "prepare.failed"; failure: CeremonyFailure }>)
  | (AsyncAction & Readonly<{ type: "auth.succeeded" }>)
  | (AsyncAction & Readonly<{ type: "auth.cancelled" }>)
  | (AsyncAction & Readonly<{ type: "auth.failed"; failure: CeremonyFailure }>)
  | (AsyncAction & Readonly<{ type: "bind.succeeded" }>)
  | (AsyncAction & Readonly<{ type: "bind.failed"; failure: CeremonyFailure }>)
  | (AsyncAction & Readonly<{ type: "profile.submit.requested" }>)
  | (AsyncAction &
      Readonly<{
        type: "profile.complete.succeeded";
        hasRecoveryMaterial: boolean;
        landingRoomId: string | null;
      }>)
  | (AsyncAction & Readonly<{ type: "profile.complete.failed"; failure: CeremonyFailure }>)
  | (AsyncAction & Readonly<{ type: "recovery.acknowledged" }>)
  | (AsyncAction & Readonly<{ type: "retry" }>)
  | Readonly<{
      /**
       * The secure handoff has passed schema/TTL/server checks and can safely
       * restore only its non-secret stage.  It is deliberately not an async
       * completion of a prior in-memory reducer instance.
       */
      type: "handoff.hydrated";
      ref: CeremonyRef;
      serverUrl: string;
      stage: ResumableCeremonyStage;
    }>
  | (AsyncAction & Readonly<{ type: "server.mismatch" }>);

/**
 * Convert transport failures to the ceremony's intentionally small recovery
 * vocabulary.  `stage` keeps a bad handle/profile from becoming a generic
 * restart, while stale/expired state always fails closed.
 */
export function failureFromHttpStatus(
  status: number,
  stage: RetryStage,
  errorCode?: string,
): Pick<Extract<InviteCeremonyState, { kind: "failure" }>, "code" | "recovery" | "retryStage"> {
  // These codes are returned today by bind-logto-user and complete-profile.
  // They must not be conflated with a consumed invite merely because they use
  // the same HTTP 409 envelope.
  if (errorCode === "handle_taken" || (errorCode === "handle_mismatch" && stage === "bind")) {
    return { code: "invalid-request", recovery: "edit-handle", retryStage: null };
  }
  if (errorCode === "not_bound" || errorCode === "invalid_state" || errorCode === "handle_mismatch") {
    return { code: "invalid-ceremony", recovery: "start-over", retryStage: null };
  }
  switch (status) {
    case 400:
      return {
        code: "invalid-request",
        recovery: stage === "prepare" ? "edit-handle" : stage === "complete-profile" ? "edit-profile" : "start-over",
        retryStage: null,
      };
    case 401:
      // The profile endpoint is already past invite registration. A normal
      // server sign-in refreshes the session, then retries this exact profile
      // handoff; rewinding to Logto registration would be both misleading and
      // unsafe after the account has been bound.
      return {
        code: "authentication-required",
        recovery: "sign-in-again",
        retryStage: stage === "complete-profile" ? "complete-profile" : "authenticate",
      };
    case 404:
      return { code: "invite-not-found", recovery: "request-new-invite", retryStage: null };
    case 409:
      return { code: "invite-already-redeemed", recovery: "request-new-invite", retryStage: null };
    case 410:
      return { code: "invite-expired", recovery: "request-new-invite", retryStage: null };
    case 422:
      return { code: "invalid-ceremony", recovery: "start-over", retryStage: null };
    case 429:
      return { code: "rate-limited", recovery: "wait-and-retry", retryStage: stage };
    default:
      if (status >= 500 && status <= 599) {
        return { code: "server-unavailable", recovery: "retry", retryStage: stage };
      }
      return { code: "server-unavailable", recovery: "retry", retryStage: stage };
  }
}

function sameCeremony(state: InviteCeremonyState, ref: CeremonyRef): boolean {
  return "ref" in state && state.ref.generation === ref.generation && state.ref.serverId === ref.serverId && state.ref.ceremonyId === ref.ceremonyId;
}

function serverUrlOf(state: InviteCeremonyState): string | null {
  return "serverUrl" in state ? state.serverUrl : null;
}

function failure(
  ref: CeremonyRef,
  serverUrl: string | null,
  input: CeremonyFailure,
  retryStage: RetryStage | null,
  activationOperation: "add" | "switch" | null = null,
  resumePreview: InvitePreview | null = null,
): InviteCeremonyState {
  if (typeof input !== "string") {
    const mapped = failureFromHttpStatus(input.status, retryStage ?? "preview", input.errorCode);
    return { kind: "failure", ref, serverUrl, ...mapped, activationOperation, resumePreview };
  }
  const code = input;
  if (code === "invalid-locator") {
    return { kind: "failure", ref, serverUrl, code, recovery: "enter-full-invite-url", retryStage: null, activationOperation, resumePreview };
  }
  if (code === "server-unreachable") {
    return { kind: "failure", ref, serverUrl, code, recovery: "verify-server", retryStage, activationOperation, resumePreview };
  }
  if (code === "server-mismatch") {
    // A mismatch invalidates this server-qualified ceremony. Its handoff must
    // be erased and the Human starts again from a complete invite locator;
    // reusing the old bearer after a mismatch is never a recovery path.
    return { kind: "failure", ref, serverUrl, code, recovery: "start-over", retryStage: null, activationOperation, resumePreview };
  }
  if (code === "offline") {
    return { kind: "failure", ref, serverUrl, code, recovery: "retry", retryStage, activationOperation, resumePreview };
  }
  if (code === "auth-cancelled") {
    return { kind: "failure", ref, serverUrl, code, recovery: "resume", retryStage: "authenticate", activationOperation, resumePreview };
  }
  if (code === "interrupted") {
    return { kind: "failure", ref, serverUrl, code, recovery: "resume", retryStage, activationOperation, resumePreview };
  }
  if (code === "server-unavailable") {
    return { kind: "failure", ref, serverUrl, code, recovery: "retry", retryStage, activationOperation, resumePreview };
  }
  const mapped = failureFromHttpStatus(
    code === "invalid-request" ? 400
      : code === "authentication-required" ? 401
        : code === "invite-not-found" ? 404
          : code === "invite-already-redeemed" ? 409
            : code === "invite-expired" ? 410
              : code === "invalid-ceremony" ? 422
                : code === "rate-limited" ? 429
                  : 500,
    retryStage ?? "preview",
  );
  return { kind: "failure", ref, serverUrl, ...mapped, activationOperation, resumePreview };
}

function previewForRecovery(state: InviteCeremonyState): InvitePreview | null {
  switch (state.kind) {
    case "preview":
    case "signed-in-boundary":
    case "preparing":
    case "external-auth":
    case "binding":
      return state.preview;
    case "failure":
      return state.resumePreview ?? null;
    default:
      return null;
  }
}

function retryState(state: Extract<InviteCeremonyState, { kind: "failure" }>): InviteCeremonyState {
  const { ref, serverUrl, retryStage, activationOperation, resumePreview } = state;
  if (state.recovery === "edit-handle" && serverUrl && resumePreview) {
    return { kind: "preview", ref, serverUrl, preview: resumePreview };
  }
  if (state.recovery === "edit-profile" && serverUrl) {
    return { kind: "profile", ref, serverUrl, handleReady: true };
  }
  if (!serverUrl || !retryStage) return state;
  switch (retryStage) {
    case "probe-server":
      return { kind: "probing-server", ref, serverUrl };
    case "activate-server":
      return activationOperation
        ? { kind: "activating-server", ref, serverUrl, operation: activationOperation }
        : { kind: "confirm-server", ref, serverUrl };
    case "preview":
      return { kind: "previewing", ref, serverUrl };
    case "prepare":
      return resumePreview ? { kind: "preparing", ref, serverUrl, preview: resumePreview } : state;
    case "authenticate":
      return resumePreview ? { kind: "external-auth", ref, serverUrl, preview: resumePreview } : state;
    case "bind":
      return resumePreview ? { kind: "binding", ref, serverUrl, preview: resumePreview } : state;
    case "complete-profile":
      return { kind: "completing-profile", ref, serverUrl };
  }
}

function generationOf(state: InviteCeremonyState): number {
  return "generation" in state ? state.generation : state.ref.generation;
}

/** A restored handoff never contains preview copy; preserve the typed shape. */
function emptyPreview(): InvitePreview {
  return { inviterHandle: null, targetRoomLabel: null, expiresAt: null };
}

function hydrateState(
  ref: CeremonyRef,
  serverUrl: string,
  stage: ResumableCeremonyStage,
): InviteCeremonyState {
  switch (stage) {
    case "preview":
      return { kind: "previewing", ref, serverUrl };
    case "external-auth":
      return { kind: "external-auth", ref, serverUrl, preview: emptyPreview() };
    case "binding":
      return { kind: "binding", ref, serverUrl, preview: emptyPreview() };
    case "profile":
      return { kind: "profile", ref, serverUrl, handleReady: true };
  }
}

/**
 * Pure reducer for screen/router orchestration.  An async event that does not
 * belong to the current generation *or* exact server is a deterministic no-op.
 */
export function reduceInviteCeremony(
  state: InviteCeremonyState,
  action: InviteCeremonyAction,
): InviteCeremonyState {
  if (action.type === "locator.accepted") {
    if (action.ref.generation <= generationOf(state)) return state;
    return { kind: "probing-server", ref: action.ref, serverUrl: action.serverUrl };
  }
  if (action.type === "locator.rejected") {
    if (action.generation <= generationOf(state)) return state;
    return { kind: "invalid-locator", generation: action.generation, recovery: "enter-full-invite-url" };
  }
  if (action.type === "handoff.hydrated") {
    // A hydration record is validated by the secure-store boundary first, but
    // generation fencing still prevents a late old record from replacing a
    // newer locator the user just opened.
    if (action.ref.generation <= generationOf(state)) return state;
    return hydrateState(action.ref, action.serverUrl, action.stage);
  }
  if (!("ref" in action) || !sameCeremony(state, action.ref)) return state;

  const ref = action.ref;
  const serverUrl = serverUrlOf(state);

  switch (action.type) {
    case "server.probe.succeeded":
      if (state.kind !== "probing-server" || action.serverUrl !== state.serverUrl) return state;
      if (!action.knownServer) return { kind: "confirm-server", ref, serverUrl: state.serverUrl };
      if (action.alreadyActive) return { kind: "previewing", ref, serverUrl: state.serverUrl };
      return { kind: "activating-server", ref, serverUrl: state.serverUrl, operation: "switch" };
    case "server.probe.failed":
      return state.kind === "probing-server" ? failure(ref, serverUrl, action.failure, "probe-server") : state;
    case "server.add.requested":
      return state.kind === "confirm-server" ? { kind: "activating-server", ref, serverUrl: state.serverUrl, operation: "add" } : state;
    case "server.switch.requested":
      return state.kind === "confirm-server" ? { kind: "activating-server", ref, serverUrl: state.serverUrl, operation: "switch" } : state;
    case "server.activation.succeeded":
      return state.kind === "activating-server" ? { kind: "previewing", ref, serverUrl: state.serverUrl } : state;
    case "server.activation.failed":
      return state.kind === "activating-server"
        ? failure(ref, serverUrl, action.failure, "activate-server", state.operation)
        : state;
    case "preview.succeeded":
      if (state.kind !== "previewing") return state;
      return action.signedIn
        ? { kind: "signed-in-boundary", ref, serverUrl: state.serverUrl, preview: action.preview }
        : { kind: "preview", ref, serverUrl: state.serverUrl, preview: action.preview };
    case "preview.failed":
      return state.kind === "previewing" ? failure(ref, serverUrl, action.failure, "preview") : state;
    case "account.keep-current":
      return state.kind === "signed-in-boundary"
        ? { kind: "cancelled", ref, serverUrl: state.serverUrl, destination: "app" }
        : state;
    case "account.switched":
      return state.kind === "signed-in-boundary" ? { kind: "preview", ref, serverUrl: state.serverUrl, preview: state.preview } : state;
    case "prepare.requested":
      return state.kind === "preview" ? { kind: "preparing", ref, serverUrl: state.serverUrl, preview: state.preview } : state;
    case "prepare.succeeded":
      return state.kind === "preparing" ? { kind: "external-auth", ref, serverUrl: state.serverUrl, preview: state.preview } : state;
    case "prepare.failed":
      return state.kind === "preparing" ? failure(ref, serverUrl, action.failure, "prepare", null, previewForRecovery(state)) : state;
    case "auth.succeeded":
      return state.kind === "external-auth" ? { kind: "binding", ref, serverUrl: state.serverUrl, preview: state.preview } : state;
    case "auth.cancelled":
      return state.kind === "external-auth" ? failure(ref, serverUrl, "auth-cancelled", "authenticate", null, previewForRecovery(state)) : state;
    case "auth.failed":
      return state.kind === "external-auth" ? failure(ref, serverUrl, action.failure, "authenticate", null, previewForRecovery(state)) : state;
    case "bind.succeeded":
      return state.kind === "binding" ? { kind: "profile", ref, serverUrl: state.serverUrl, handleReady: true } : state;
    case "bind.failed":
      return state.kind === "binding" ? failure(ref, serverUrl, action.failure, "bind", null, previewForRecovery(state)) : state;
    case "profile.submit.requested":
      return state.kind === "profile" ? { kind: "completing-profile", ref, serverUrl: state.serverUrl } : state;
    case "profile.complete.succeeded":
      if (state.kind !== "completing-profile") return state;
      if (action.hasRecoveryMaterial) {
        return {
          kind: "recovery-acknowledgement",
          ref,
          serverUrl: state.serverUrl,
          recoveryMaterialAvailable: true,
          landingRoomId: action.landingRoomId,
        };
      }
      return { kind: "success", ref, landingRoomId: action.landingRoomId };
    case "profile.complete.failed":
      return state.kind === "completing-profile" ? failure(ref, serverUrl, action.failure, "complete-profile") : state;
    case "recovery.acknowledged":
      return state.kind === "recovery-acknowledgement"
        ? { kind: "success", ref, landingRoomId: state.landingRoomId }
        : state;
    case "retry":
      return state.kind === "failure" ? retryState(state) : state;
    case "server.mismatch":
      return failure(ref, serverUrl, "server-mismatch", null);
    default:
      return state;
  }
}
