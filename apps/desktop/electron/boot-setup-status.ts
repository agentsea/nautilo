import { NautiloApiClient, type SetupStatusResponse } from "@nautilo/api-client";

/**
 * D092-style routing hook — historically always `"ready"`.
 * D112 maps from `GET /api/setup/status` (guest / no bearer at boot).
 */
export type ServerClaimState = "unclaimed" | "invite-pending" | "ready" | "authenticated";

/**
 * D103 Phase 4c — claim-state parity decision matrix.
 *
 * Maps Stack 1's `setupState` (4 values) + optional `viewer` into the
 * desktop shell's 4-value `ServerClaimState`. Previously this mapper
 * collapsed 3 of 4 setupStates into "ready", losing renderer-visible
 * distinctions between unclaimed / claim-pending / authenticated.
 *
 *   setupState           | viewer    | → ServerClaimState | Rationale
 *   ---------------------|-----------|--------------------|--------------------------------
 *   fresh-unclaimed      | absent    | unclaimed          | brand-new server; claim via CLI / first-run flow
 *   claimed-needs-auth   | absent    | invite-pending     | claimed (DB row) but this client not authed; show sign-in
 *   server-needs-keys    | maybe     | invite-pending     | claimed but BYOK keys missing; admin path. From client's
 *                        |           |                    | POV identical to invite-pending — renderer setup screen
 *                        |           |                    | disambiguates, NOT here.
 *   ready                | absent    | ready              | operational; client not yet signed in but can attempt OIDC
 *   ready                | present   | authenticated      | operational AND /api/setup/status recognized our session
 *
 *   null (boot probe failed)        | → ready              | let downstream error paths handle it
 *
 * The `_exhaustive: never` default branch is a deliberate type-level
 * assertion: if Stack 1 adds a new `setupState` value to the schema,
 * TypeScript fails the build here until this mapper is updated. This is
 * the single most important defense against silent drift.
 */
export function mapSetupStatusToServerClaimState(
  st: SetupStatusResponse | null,
): ServerClaimState {
  if (!st) return "ready";

  switch (st.setupState) {
    case "fresh-unclaimed":
      return "unclaimed";
    case "claimed-needs-auth":
    case "server-needs-keys":
      return "invite-pending";
    case "ready":
      return st.viewer !== undefined ? "authenticated" : "ready";
    default: {
      const _exhaustive: never = st.setupState;
      return _exhaustive;
    }
  }
}

/**
 * Phase 4d wiring point — probe an arbitrary server URL and return its
 * `ServerClaimState` plus the raw setup-status payload. Used by the
 * first-run URL-picker IPC to branch UX (e.g., "this server is
 * unclaimed — would you like to claim it?").
 *
 * Network/parse failures collapse to `{ state: "ready", raw: null }`
 * so the caller's existing "ready" path renders the connection-error
 * UI rather than crashing the IPC handler.
 */
export async function probeServerClaimStateForUrl(
  serverUrl: string,
  signal?: AbortSignal,
): Promise<{ state: ServerClaimState; raw: SetupStatusResponse | null }> {
  try {
    signal?.throwIfAborted();
    const client = new NautiloApiClient(serverUrl.replace(/\/$/, ""));
    const raw = await client.getSetupStatus(signal ? { signal } : undefined);
    // A test/custom transport may resolve after cancellation instead of
    // rejecting like standards-compliant fetch. Fence that late payload here
    // so it can never become the candidate's setup fact.
    signal?.throwIfAborted();
    return { state: mapSetupStatusToServerClaimState(raw), raw };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { state: "ready", raw: null };
  }
}

/** Skip the Genie onboarding wizard when it cannot succeed or is unnecessary. */
export function shouldSkipGenieOnboardingWizard(st: SetupStatusResponse | null): boolean {
  if (!st) return false;
  if (st.setupState === "fresh-unclaimed") return true;
  if (st.setupState === "claimed-needs-auth") return true;
  if (st.setupState === "server-needs-keys") return true;
  if (st.setupState === "ready" && st.viewer !== undefined) {
    if (st.viewer.canInvokeAgents === false) return true;
    return st.viewer.genieCustomized === true;
  }
  return false;
}

/** When setup already exposes `viewer`, force wizard open for default Genie. */
export function shouldForceGenieOnboardingFromSetup(st: SetupStatusResponse | null): boolean {
  if (!st) return false;
  return (
    st.setupState === "ready" &&
    st.viewer !== undefined &&
    st.viewer.canInvokeAgents !== false &&
    st.viewer.genieCustomized === false
  );
}
