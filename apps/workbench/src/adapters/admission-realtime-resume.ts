import type { RealtimeClient } from "@nautilo/realtime-client";
import type { CryptoAdmissionSnapshot } from "../lib/crypto-admission-access";

type AdmissionResumeState = Pick<CryptoAdmissionSnapshot, "status" | "identity">;

/** Resume a mount-scoped realtime client only after the retained identity's
 * authoritative admission check reopens. `reconnect()` is itself a no-op unless
 * the client's bounded auth-failure latch is suspended. */
export function resumeRealtimeAfterAdmission(input: Readonly<{
  client: RealtimeClient | null;
  previous: AdmissionResumeState;
  current: AdmissionResumeState;
}>): boolean {
  if (
    (input.previous.status !== "paused" && input.previous.status !== "blocked")
    || input.current.status !== "open"
    || input.previous.identity === null
    || input.previous.identity !== input.current.identity
  ) {
    return false;
  }
  input.client?.reconnect();
  return true;
}
