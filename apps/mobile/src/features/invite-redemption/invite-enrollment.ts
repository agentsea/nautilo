/**
 * The native invite enrollment spine.
 *
 * This deliberately keeps the invite bearer and opaque preparation state in
 * the verified handoff boundary.  The screen receives only a tagged outcome
 * and drives the existing ceremony reducer; it never renders or logs either
 * secret.  Supplying the dependencies makes the order and stale fences
 * testable without Expo or SecureStore.
 */
import { HANDLE_INVALID_MESSAGE, HANDLE_RE, normalizeHandle } from "@nautilo/types";

import {
  failureFromHttpStatus,
  type CeremonyFailure,
  type CeremonyRef,
  type RetryStage,
} from "./invite-ceremony";
import type { InviteHandoffInput, InviteHandoffRecord } from "./invite-handoff";
import { NativeAuthError } from "@/lib/auth-request";

export type InviteEnrollmentStart = "prepare" | "authenticate" | "bind";

export type InviteEnrollmentResult =
  | Readonly<{ kind: "bound" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "prepare-failed"; failure: CeremonyFailure }>
  | Readonly<{ kind: "auth-failed"; failure: CeremonyFailure }>
  | Readonly<{ kind: "bind-failed"; failure: CeremonyFailure }>;

export type InviteEnrollmentDependencies = Readonly<{
  isCurrent: (ref: CeremonyRef) => boolean;
  loadHandoff: (server: Readonly<{ serverId: string; serverUrl: string }>) => Promise<InviteHandoffRecord | null>;
  saveHandoff: (input: InviteHandoffInput) => Promise<InviteHandoffRecord>;
  prepare: (inviteToken: string, input: Readonly<{ handle: string }>) => Promise<Readonly<{ state: string }>>;
  authenticate: (input: Readonly<{ serverId: string; serverUrl: string; handle: string }>) => Promise<"completed" | "stale" | "server-mismatch">;
  bind: (input: Readonly<{ state: string }>) => Promise<unknown>;
  onPrepared: () => void;
  onAuthenticated: () => void;
}>;

export type HandleValidation =
  | Readonly<{ valid: true; handle: string }>
  | Readonly<{ valid: false; message: typeof HANDLE_INVALID_MESSAGE }>;

/** Native input shares the server's only handle grammar and normalization. */
export function validateInviteHandle(raw: string): HandleValidation {
  const handle = normalizeHandle(raw);
  return HANDLE_RE.test(handle)
    ? { valid: true, handle }
    : { valid: false, message: HANDLE_INVALID_MESSAGE };
}

function safeErrorCode(value: unknown): string | undefined {
  // ApiError's message is only used here when it is a known protocol code.
  // Never carry arbitrary provider/transport text into ceremony state.
  if (!(value instanceof Error)) return undefined;
  return value.message === "handle_taken" || value.message === "handle_mismatch" || value.message === "invalid_state"
    ? value.message
    : undefined;
}

/** Convert failures to the reducer's deliberately small, display-safe type. */
export function enrollmentFailureFromError(error: unknown): CeremonyFailure {
  if (error instanceof NativeAuthError && error.code === "cancelled") return "auth-cancelled";
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status)) {
      const errorCode = safeErrorCode(error);
      return errorCode ? { status, errorCode } : { status };
    }
  }
  if (error instanceof TypeError) return "offline";
  return "server-unavailable";
}

/**
 * Decide custody from the reducer's complete recovery outcome, not from a
 * lossy error code. In particular, bind's generic 400 is `start-over`, while
 * only the explicit handle branch may retain the invite for another choice.
 */
export function retainInviteEnrollmentFailure(
  failure: CeremonyFailure,
  stage: Extract<RetryStage, "prepare" | "authenticate" | "bind">,
): boolean {
  if (typeof failure === "string") {
    return failure === "auth-cancelled" || failure === "authentication-required" || failure === "offline"
      || failure === "server-unavailable" || failure === "server-unreachable" || failure === "rate-limited";
  }
  const mapped = failureFromHttpStatus(failure.status, stage, failure.errorCode);
  return mapped.recovery === "edit-handle" || mapped.recovery === "sign-in-again" || mapped.code === "offline"
    || mapped.code === "server-unavailable" || mapped.code === "server-unreachable" || mapped.code === "rate-limited";
}

function toHandoffInput(
  handoff: InviteHandoffRecord,
  stage: InviteHandoffInput["stage"],
  prepareState: string | null,
  handle: string | null,
): InviteHandoffInput {
  return {
    serverId: handoff.serverId,
    serverUrl: handoff.serverUrl,
    inviteToken: handoff.inviteToken,
    prepareState,
    handle,
    stage,
    startedAt: handoff.startedAt,
    inviteExpiresAt: handoff.expiresAt,
  };
}

function validPreparedHandoff(handoff: InviteHandoffRecord | null): handoff is InviteHandoffRecord & { prepareState: string; handle: string } {
  return Boolean(
    handoff
      && (handoff.stage === "external-auth" || handoff.stage === "binding")
      && handoff.prepareState
      && handoff.handle,
  );
}

/**
 * Execute only the remaining portion of one server-qualified ceremony.
 * Every async boundary fences the original ref; a stale hosted-auth return is
 * reported without writing over a newer handoff.  `authenticate` owns the
 * matching-token cleanup required when it observes that stale return.
 */
export async function runInviteEnrollment(
  input: Readonly<{
    ref: CeremonyRef;
    serverUrl: string;
    start: InviteEnrollmentStart;
    handle: string | null;
  }>,
  deps: InviteEnrollmentDependencies,
): Promise<InviteEnrollmentResult> {
  const server = { serverId: input.ref.serverId, serverUrl: input.serverUrl };
  if (!deps.isCurrent(input.ref)) return { kind: "stale" };

  let handoff: InviteHandoffRecord | null;
  try {
    handoff = await deps.loadHandoff(server);
  } catch {
    return { kind: input.start === "prepare" ? "prepare-failed" : input.start === "authenticate" ? "auth-failed" : "bind-failed", failure: "server-unavailable" };
  }
  if (!deps.isCurrent(input.ref)) return { kind: "stale" };

  if (input.start === "prepare") {
    if (!handoff || handoff.stage !== "preview" || !input.handle) {
      return { kind: "prepare-failed", failure: { status: 422 } };
    }
    try {
      const prepared = await deps.prepare(handoff.inviteToken, { handle: input.handle });
      if (!deps.isCurrent(input.ref)) return { kind: "stale" };
      handoff = await deps.saveHandoff(toHandoffInput(handoff, "external-auth", prepared.state, input.handle));
      if (!deps.isCurrent(input.ref)) return { kind: "stale" };
      deps.onPrepared();
    } catch (error) {
      return { kind: "prepare-failed", failure: enrollmentFailureFromError(error) };
    }
  }

  if (handoff?.stage === "binding") {
    // The authenticated browser return has already been persisted. Continue
    // directly to the idempotent bind rather than launching Logto again. A
    // resumed external-auth renderer still needs its reducer phase advanced.
    if (input.start !== "bind") deps.onAuthenticated();
  } else {
    if (!validPreparedHandoff(handoff)) return { kind: "auth-failed", failure: { status: 422 } };
    if (handoff.stage === "external-auth") {
      try {
        const authenticated = await deps.authenticate({ ...server, handle: handoff.handle });
        if (authenticated === "stale" || !deps.isCurrent(input.ref)) return { kind: "stale" };
        if (authenticated === "server-mismatch") return { kind: "auth-failed", failure: "server-mismatch" };
        handoff = await deps.saveHandoff(toHandoffInput(handoff, "binding", handoff.prepareState, handoff.handle));
        if (!deps.isCurrent(input.ref)) return { kind: "stale" };
        deps.onAuthenticated();
      } catch (error) {
        return { kind: "auth-failed", failure: enrollmentFailureFromError(error) };
      }
    }
  }

  if (!validPreparedHandoff(handoff) || handoff.stage !== "binding") {
    return { kind: "bind-failed", failure: { status: 422 } };
  }
  try {
    await deps.bind({ state: handoff.prepareState });
    if (!deps.isCurrent(input.ref)) return { kind: "stale" };
    await deps.saveHandoff(toHandoffInput(handoff, "profile", null, handoff.handle));
    if (!deps.isCurrent(input.ref)) return { kind: "stale" };
    return { kind: "bound" };
  } catch (error) {
    return { kind: "bind-failed", failure: enrollmentFailureFromError(error) };
  }
}

export type InviteAuthenticationRewindDependencies = Readonly<{
  isCurrent: (ref: CeremonyRef) => boolean;
  loadHandoff: (server: Readonly<{ serverId: string; serverUrl: string }>) => Promise<InviteHandoffRecord | null>;
  saveHandoff: (input: InviteHandoffInput) => Promise<InviteHandoffRecord>;
  clearAuthentication: (input: Readonly<{ serverId: string; serverUrl: string; isCurrent: () => boolean }>) => Promise<"cleared" | "stale" | "server-mismatch">;
}>;

export type InviteAuthenticationRewindResult = "rewound" | "stale" | "server-mismatch" | "custody-failed";

/**
 * A bind 401 means its bearer cannot be retried. Clear that exact server's
 * unbound bundle, then atomically re-stage the verified ceremony for the same
 * hosted registration path. No new prepare request occurs and every boundary
 * is fenced so replacement intake owns its own bytes.
 */
export async function rewindInviteAuthentication(
  input: Readonly<{ ref: CeremonyRef; serverUrl: string }>,
  deps: InviteAuthenticationRewindDependencies,
): Promise<InviteAuthenticationRewindResult> {
  const server = { serverId: input.ref.serverId, serverUrl: input.serverUrl };
  if (!deps.isCurrent(input.ref)) return "stale";
  let handoff: InviteHandoffRecord | null;
  try {
    handoff = await deps.loadHandoff(server);
  } catch {
    return "custody-failed";
  }
  if (!deps.isCurrent(input.ref)) return "stale";
  if (!validPreparedHandoff(handoff) || handoff.stage !== "binding") return "custody-failed";
  let cleared: "cleared" | "stale" | "server-mismatch";
  try {
    cleared = await deps.clearAuthentication({ ...server, isCurrent: () => deps.isCurrent(input.ref) });
  } catch {
    return "custody-failed";
  }
  if (cleared !== "cleared" || !deps.isCurrent(input.ref)) return cleared === "server-mismatch" ? "server-mismatch" : "stale";
  try {
    await deps.saveHandoff(toHandoffInput(handoff, "external-auth", handoff.prepareState, handoff.handle));
  } catch {
    return "custody-failed";
  }
  return deps.isCurrent(input.ref) ? "rewound" : "stale";
}
