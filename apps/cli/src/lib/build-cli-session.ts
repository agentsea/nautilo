import type { CliSessionV1Payload, NautiloApiClient } from "@nautilo/api-client";
import { pickHighestRoleSlug } from "@nautilo/api-client";
import { jwtExpiryMs } from "./jwt-exp.ts";

export async function cliSessionFromWhoami(
  api: NautiloApiClient,
  serverUrl: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresAt: number,
  source: CliSessionV1Payload["source"],
  targetBinding?: CliSessionV1Payload["targetBinding"],
  authBinding?: CliSessionV1Payload["authBinding"],
): Promise<CliSessionV1Payload> {
  const w = await api.whoami();
  if (
    !w.sessionUserId
    || w.handle == null
    || w.displayName == null
    || w.externalId == null
  ) {
    throw new Error("whoami_missing_identity");
  }
  const highestRole = pickHighestRoleSlug(w.groups ?? []);
  return {
    schemaVersion: 1,
    instanceId: w.instanceId,
    serverUrl: serverUrl.trim().replace(/\/+$/, ""),
    handle: w.handle,
    displayName: w.displayName,
    actorRole: highestRole,
    externalId: w.externalId,
    ...(targetBinding ? { targetBinding } : {}),
    ...(authBinding ? { authBinding } : {}),
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    tokenType: "Bearer",
    expiresAt,
    scopes: [],
    source,
    obtainedAt: Date.now(),
  };
}

export function tokenExpiryMs(accessToken: string, fallbackMsFromNow: number): number {
  return jwtExpiryMs(accessToken) ?? Date.now() + fallbackMsFromNow;
}
