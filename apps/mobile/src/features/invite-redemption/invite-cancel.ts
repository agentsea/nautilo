import type { InviteCeremonyState } from "./invite-ceremony";

export type InviteCancelDestination = "app" | "add-server";

const PREVIEW_TERMINAL_FAILURES = new Set([
  "invite-not-found",
  "invite-already-redeemed",
  "invite-expired",
]);

/**
 * Cancelling a bad locator must not strand an already signed-in Human in
 * onboarding.  This intentionally applies only before invite authentication:
 * a partially completed registration must still fail closed to setup.
 */
export function inviteCancelDestination(
  ceremony: InviteCeremonyState,
  input: Readonly<{
    authStatus: "loading" | "signed-in" | "signed-out";
    activeServerId: string | null;
  }>,
): InviteCancelDestination {
  if (ceremony.kind === "signed-in-boundary") return "app";
  if (
    ceremony.kind === "failure"
    && input.authStatus === "signed-in"
    && input.activeServerId === ceremony.ref.serverId
    && (
      ceremony.retryStage === "preview"
      || (ceremony.retryStage === null && PREVIEW_TERMINAL_FAILURES.has(ceremony.code))
    )
  ) {
    return "app";
  }
  return "add-server";
}
