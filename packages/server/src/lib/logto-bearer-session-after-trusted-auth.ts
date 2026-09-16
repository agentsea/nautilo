import type { LogtoAdminClient } from "@nautilo/trust";

/**
 * Mint a Logto bearer session for a user we have already authenticated
 * through some other trusted path — **redeem-claim** (loopback invite
 * redeem) or **password-login** (Management API `verifyUserPassword`).
 * Both callers have verified the subject out-of-band; this helper only
 * exchanges that trust for a first-party OIDC access token the CLI can use
 * without forcing device flow.
 *
 * Logto does not support `grant_type=password` for this hop. Instead:
 * 1. Management API: `POST /api/users/{id}/personal-access-tokens`
 * 2. Native token exchange: `POST …/oidc/token` with
 *    `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` and
 *    `subject_token_type=urn:logto:token-type:personal_access_token`
 *
 * The legacy-named CLI device application must allow token exchange (bootstrap-logto
 * reconciles `customClientMetadata.allowTokenExchange`).
 */

export type MintedLogtoClaimSession = {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresIn: number;
  idToken?: string | undefined;
};

export async function mintLogtoBearerSessionAfterTrustedAuth(args: {
  logto: LogtoAdminClient;
  logtoSub: string;
}): Promise<MintedLogtoClaimSession | null> {
  // M092 — prefer container-DNS endpoint when present (deploy stack).
  // Host-mode falls back to `LOGTO_ENDPOINT`.
  const endpoint = (
    process.env["LOGTO_ENDPOINT_INTERNAL"] ?? process.env["LOGTO_ENDPOINT"]
  )
    ?.trim()
    .replace(/\/$/, "");
  const tuiAppId = process.env["LOGTO_TUI_APP_ID"]?.trim();
  const resource = process.env["LOGTO_RESOURCE"]?.trim();
  if (!endpoint || !tuiAppId || !resource) {
    return null;
  }

  const patName = `nautilo-claim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let patValue: string;
  try {
    const pat = await args.logto.createPersonalAccessToken(args.logtoSub, {
      name: patName,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    patValue = pat.value;
  } catch {
    return null;
  }

  const scope = "openid offline_access profile email";
  const body = new URLSearchParams({
    client_id: tuiAppId,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    resource,
    scope,
    subject_token: patValue,
    subject_token_type: "urn:logto:token-type:personal_access_token",
  });

  let res: Response;
  try {
    res = await fetch(`${endpoint}/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    return null;
  }

  if (!res.ok) {
    return null;
  }

  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const accessToken =
    typeof json["access_token"] === "string" ? json["access_token"] : null;
  const refreshToken =
    typeof json["refresh_token"] === "string" ? json["refresh_token"] : null;
  if (!accessToken) {
    return null;
  }

  const expiresIn =
    typeof json["expires_in"] === "number" && Number.isFinite(json["expires_in"])
      ? json["expires_in"]
      : 3600;

  const idToken =
    typeof json["id_token"] === "string" ? json["id_token"] : undefined;

  // TODO(D119§3): revoke PAT after exchange

  return {
    accessToken,
    expiresIn,
    ...(refreshToken !== null ? { refreshToken } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
  };
}
