// D369 Phase 1 — api-client bound to the active server.
// MUST import from @nautilo/api-client/browser (the root pulls node:fs and
// breaks Metro — D369 reuse map). baseUrl is injectable; setTokenProvider
// gets wired to per-server tokens in Phase 2.
import { NautiloApiClient } from "@nautilo/api-client/browser";

import { ensureValidToken } from "@/lib/auth";
import { emitAuthDead } from "@/lib/auth-events";
import { isDeadSessionResponse } from "@/lib/session-expiry";
import { serverIdFromUrl } from "@/lib/server-store";
import { serverUrlCandidates } from "@/lib/server-url";

export { normalizeServerUrl } from "@/lib/server-url";

let client: NautiloApiClient | null = null;
let boundBaseUrl: string | null = null;

/** Get (or rebuild) the singleton client bound to `baseUrl`, token-provider wired. */
export function getApiClient(baseUrl: string): NautiloApiClient {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (!client || boundBaseUrl !== normalized) {
    client = new NautiloApiClient(normalized);
    boundBaseUrl = normalized;
    const id = serverIdFromUrl(normalized);
    // D398 — always hand out a FRESH token: ensureValidToken silently refreshes
    // on/near expiry. When it returns null the refresh is dead (tokens cleared)
    // → raise auth-dead so AuthProvider signs out and the gate redirects to
    // login, instead of quietly sending a guest request that fails with a bare
    // "failed to send". (ensureValidToken is used lazily at call time — the
    // api.ts ↔ auth.ts import cycle is init-safe.)
    client.setTokenProvider(async () => {
      const token = await ensureValidToken(id, normalized);
      if (!token) emitAuthDead(id);
      return token;
    });
    client.setUnauthorizedResponseHandler(async (response) => {
      if (!isDeadSessionResponse(response)) return;
      if (response.retryAttempted) {
        emitAuthDead(id);
        return null;
      }
      const token = await ensureValidToken(id, normalized, { forceRefresh: true });
      if (!token) emitAuthDead(id);
      return token;
    });
  }
  return client;
}

export type ProbeResult =
  | { ok: true; displayName: string; serverUrl: string }
  | { ok: false; error: string };

/** Validate a server URL by hitting unauthenticated /health. */
export async function probeServer(rawUrl: string): Promise<ProbeResult> {
  const candidates = serverUrlCandidates(rawUrl);
  if (candidates.length === 0) return { ok: false, error: "Enter a valid http(s) URL" };
  let lastError = "Server unreachable";
  for (const url of candidates) {
    try {
    const probe = new NautiloApiClient(url);
    // /health is unauthenticated — validates reachability + that it's Nautilo.
    const health = await probe.getHealth();
    if (!health || typeof health.status !== "string") {
      return { ok: false, error: "Not a Nautilo server" };
    }
    // Human name from the server profile (best-effort); fall back to host.
    let displayName = new URL(url).host;
    try {
      const profile = await probe.getServerProfile();
      if (profile?.name) displayName = profile.name;
    } catch {
      // profile may be gated/absent pre-setup — host fallback is fine.
    }
      return { ok: true, displayName, serverUrl: url };
    } catch (e) {
      lastError = e instanceof Error ? e.message : "Server unreachable";
    }
  }
  return { ok: false, error: lastError };
}
