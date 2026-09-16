/**
 * D112 Phase 5.2 — `GET /api/setup/status` preconditions for `nautilo-dev`.
 * Shipped product CLI (`nautilo`, D094) should share the same messages.
 */
import { NautiloApiClient, getDevServerBaseUrl, type SetupStatusResponse } from "@nautilo/api-client";

export type SetupState = SetupStatusResponse["setupState"];

/** Operator-facing copy until D094 ships `nautilo setup claim`. */
export const SETUP_STATE_CLI_HINTS: Record<SetupState, string> = {
  "fresh-unclaimed":
    "Server is not yet claimed (setupState=fresh-unclaimed). Complete onboarding or redeem the claim invite first. Check: `bun run dev:setup-status`.",
  "claimed-needs-auth":
    "Server is claimed but needs an authenticated owner session (setupState=claimed-needs-auth). Sign in via Workbench, the Desktop app, or `nautilo login`, then retry.",
  "server-needs-keys":
    "Provider / LLM keys are still required (setupState=server-needs-keys). Configure them in the workbench admin providers UI, then retry.",
  ready: "",
};

export function buildSetupStatePreconditionMessage(
  commandLabel: string,
  state: SetupState,
): string {
  const hint = SETUP_STATE_CLI_HINTS[state];
  return `[nautilo-dev] ${commandLabel}: not allowed while setupState=${state}. ${hint}`;
}

/**
 * States where the instance is past the “mint claim invite only” phase.
 * Aligns with product flows that assume a claimed server (keys may still be missing).
 */
export const SETUP_STATES_CLAIMED_OR_LATER: ReadonlySet<SetupState> = new Set([
  "claimed-needs-auth",
  "server-needs-keys",
  "ready",
]);

async function fetchSetupStatusForCli(): Promise<SetupStatusResponse> {
  const client = new NautiloApiClient(getDevServerBaseUrl());
  return client.getSetupStatus();
}

/**
 * Fetches setup status; **exits 2** if unreachable or `setupState` ∉ `allowed`.
 */
export async function exitUnlessSetupStateIn(
  allowed: ReadonlySet<SetupState>,
  commandLabel: string,
): Promise<SetupStatusResponse> {
  let status: SetupStatusResponse;
  try {
    status = await fetchSetupStatusForCli();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[nautilo-dev] ${commandLabel}: cannot fetch GET /api/setup/status from ${getDevServerBaseUrl()}: ${msg}`,
    );
    console.error(
      "[nautilo-dev] Hint: ensure the Nautilo server is running, or set NAUTILO_SERVER_URL.",
    );
    process.exit(2);
  }
  if (!allowed.has(status.setupState)) {
    console.error(buildSetupStatePreconditionMessage(commandLabel, status.setupState));
    process.exit(2);
  }
  return status;
}
