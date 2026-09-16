/**
 * Native invite profile completion stays deliberately separate from the
 * renderer. PINs, display names, and recovery material are never persisted in
 * the invite handoff or reducer; this module receives them only in the narrow
 * request closure and returns tagged, safe failure state.
 */
import type { CeremonyFailure, CeremonyRef } from "./invite-ceremony";
import type { InviteHandoffRecord } from "./invite-handoff";

const PIN_RE = /^\d{6,8}$/;

export type InviteProfileValidation = Readonly<{
  valid: boolean;
  displayName: string;
  displayNameError: string | null;
  pinError: string | null;
}>;

export function validateInviteProfile(
  displayNameInput: string,
  pin: string,
  pinConfirmation: string,
): InviteProfileValidation {
  const displayName = displayNameInput.trim();
  const displayNameError = displayName ? null : "Enter a display name.";
  const pinError = !PIN_RE.test(pin)
    ? "Use a 6–8 digit PIN."
    : pin !== pinConfirmation
      ? "PIN entries don't match."
      : null;
  return {
    valid: !displayNameError && !pinError,
    displayName,
    displayNameError,
    pinError,
  };
}

function safeProfileErrorCode(value: unknown): string | undefined {
  if (!(value instanceof Error)) return undefined;
  return value.message === "not_bound" || value.message === "invalid_state" || value.message === "handle_mismatch"
    ? value.message
    : undefined;
}

/** Error text is never exposed; only protocol status and narrow known code survive. */
export function inviteProfileFailureFromError(error: unknown): CeremonyFailure {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status)) {
      const errorCode = safeProfileErrorCode(error);
      return errorCode ? { status, errorCode } : { status };
    }
  }
  if (error instanceof TypeError) return "offline";
  return "server-unavailable";
}

export type InviteProfileResult =
  | Readonly<{ kind: "completed"; recoveryCodes: readonly string[]; landingRoomId: string | null }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "failed"; failure: CeremonyFailure }>;

export type InviteProfileDependencies = Readonly<{
  isCurrent: (ref: CeremonyRef) => boolean;
  loadHandoff: (server: Readonly<{ serverId: string; serverUrl: string }>) => Promise<InviteHandoffRecord | null>;
  complete: (inviteToken: string, input: Readonly<{ displayName: string; pin: string }>) => Promise<Readonly<{
    recoveryCodes: readonly string[];
    landingRoomId: string | null;
  }>>;
}>;

/**
 * Complete exactly one profile-stage ceremony. The caller owns its deletion
 * through the intake coordinator before recovery codes ever reach React state.
 */
export async function runInviteProfileCompletion(
  input: Readonly<{
    ref: CeremonyRef;
    serverUrl: string;
    displayName: string;
    pin: string;
  }>,
  deps: InviteProfileDependencies,
): Promise<InviteProfileResult> {
  const server = { serverId: input.ref.serverId, serverUrl: input.serverUrl };
  if (!deps.isCurrent(input.ref)) return { kind: "stale" };
  let handoff: InviteHandoffRecord | null;
  try {
    handoff = await deps.loadHandoff(server);
  } catch {
    return { kind: "failed", failure: "server-unavailable" };
  }
  if (!deps.isCurrent(input.ref)) return { kind: "stale" };
  if (!handoff || handoff.stage !== "profile") return { kind: "failed", failure: { status: 422 } };
  try {
    const result = await deps.complete(handoff.inviteToken, { displayName: input.displayName, pin: input.pin });
    if (!deps.isCurrent(input.ref)) return { kind: "stale" };
    return {
      kind: "completed",
      // This copy remains only in the active promise → screen-local state
      // transfer. It is not persisted, reduced, or sent through navigation.
      recoveryCodes: result.recoveryCodes,
      landingRoomId: result.landingRoomId,
    };
  } catch (error) {
    return { kind: "failed", failure: inviteProfileFailureFromError(error) };
  }
}
