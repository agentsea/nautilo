import type { ResumableCeremonyStage } from "./invite-ceremony";
import type { InviteRoute } from "./invite-intake";

export type InviteCallbackRecovery =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "restore"; route: InviteRoute }>;

export type InviteCallbackFallback =
  | Readonly<{ kind: "resume"; route: InviteRoute }>
  | Readonly<{ kind: "restart" }>;

/**
 * A hosted OAuth callback is only transport.  Re-enter the native ceremony
 * after the original async spine has durably reached its profile handoff;
 * returning sooner would launch a second hosted registration or race bind.
 */
export function inviteCallbackRecovery(
  route: InviteRoute | null,
  stage: ResumableCeremonyStage | null,
): InviteCallbackRecovery {
  if (!route) return { kind: "unavailable" };
  return stage === "profile" ? { kind: "restore", route } : { kind: "waiting" };
}

/** A bounded callback timeout must still leave a user a safe next action. */
export function inviteCallbackFallback(route: InviteRoute | null): InviteCallbackFallback {
  return route ? { kind: "resume", route } : { kind: "restart" };
}
