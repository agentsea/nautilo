/**
 * M055 — sign-in orchestrator: PKCE pair → loopback server →
 * shell.openExternal → wait for callback → exchange code for tokens →
 * persist via token-store.
 *
 * Dependency-injected so the unit test can verify the flow end-to-end
 * without a real Logto, real browser, or real safeStorage. The
 * Electron-bound facade lives in `sign-in-electron.ts` and wires the
 * real `shell.openExternal` + `globalThis.fetch` + token-store-electron.
 */
import { generatePkcePair, generateState } from "./pkce";
import {
  startLoopbackServer,
  type LoopbackHandle,
} from "./loopback-server";
import type { TokenBundle } from "./token-store";

export interface SignInConfig {
  /** Logto OIDC core endpoint, e.g. `http://localhost:3301`. */
  endpoint: string;
  /** `LOGTO_DESKTOP_APP_ID` — the Native app from M055 Phase 0. */
  appId: string;
  /** `LOGTO_RESOURCE` — API audience the workbench requests. */
  resource: string;
  /**
   * M106 — extra OIDC authorize-URL params. Used by the invite wizard
   * to thread `one_time_token` + `login_hint` so a new user signs up
   * with Logto's magic-link primitive instead of needing a password.
   */
  extraParams?: Record<string, string>;
}

export interface SignInDeps {
  /**
   * Opens the auth URL — embedded `BrowserWindow` in production, or
   * `shell.openExternal` if we ever flip back to the system browser.
   * Returns a `closeAuthSurface` callback the orchestrator calls
   * after the loopback callback fires (or fails) so the embedded
   * window doesn't linger after sign-in completes. The returned
   * callback is a no-op for external-browser strategies.
   */
  openAuthUrl: (url: string) => Promise<{ closeAuthSurface: () => void }>;
  /** HTTP client. `globalThis.fetch` in prod. */
  fetchImpl: typeof fetch;
  /** Persists the token bundle on success. */
  saveTokens: (tokens: TokenBundle) => void;
  /** Test injection point; defaults to the real loopback server. */
  startLoopback?: typeof startLoopbackServer;
}

export interface SignInResult {
  bundle: TokenBundle;
}

interface TokenResponse {
  access_token: string;
  /**
   * Required since M060 — see TokenBundle.refresh_token rationale.
   * If Logto ever stops returning one, the bundle build below will
   * write `undefined` and `loadTokens` will reject it on next launch,
   * surfacing the regression loud rather than silently re-prompting.
   */
  refresh_token: string;
  id_token: string;
  expires_in: number;
}

export async function runSignIn(
  config: SignInConfig,
  deps: SignInDeps,
): Promise<SignInResult> {
  const pkce = generatePkcePair();
  const state = generateState();

  const startLoopback = deps.startLoopback ?? startLoopbackServer;
  const loopback: LoopbackHandle = await startLoopback();
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;

  const authUrl = new URL(`${config.endpoint}/oidc/auth`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.appId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid offline_access profile email");
  authUrl.searchParams.set("resource", config.resource);
  authUrl.searchParams.set("code_challenge", pkce.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  // M060 — Logto OSS gates `offline_access` behind `prompt=consent` for
  // Native apps (see comment block below). M061 — add `login` so a prior
  // Logto browser session (SSO cookie) cannot skip the identifier/password
  // step after sign-out; Logto recommends `login consent` when using
  // offline_access (https://docs.logto.io/end-user-flows/sign-out).
  authUrl.searchParams.set("prompt", "login consent");
  // M106 — magic-link sign-up extras. Logto accepts `one_time_token` +
  // `login_hint` on the authorize endpoint and skips the password
  // challenge when the token verifies.
  if (config.extraParams) {
    for (const [k, v] of Object.entries(config.extraParams)) {
      if (typeof v === "string" && v.length > 0) {
        authUrl.searchParams.set(k, v);
      }
    }
  }

  const { closeAuthSurface } = await deps.openAuthUrl(authUrl.toString());

  let captured;
  try {
    captured = await loopback.awaitCallback;
  } finally {
    loopback.shutdown();
    closeAuthSurface();
  }

  if (captured.state !== state) {
    throw new Error(
      "OIDC state mismatch — possible CSRF; aborting sign-in",
    );
  }

  // RFC 8707 + Logto OSS: the `resource` param MUST be passed on the
  // token exchange (not just the /oidc/auth call) for the issued
  // access token to carry the requested audience. Without this Logto
  // mints an opaque token for its own userinfo endpoint and the
  // server's `verifyLogtoAccessToken` rejects with audience mismatch
  // → preHandler falls through to guest. (Same fix `@logto/react`'s
  // SDK applies internally for the browser path in M054.)
  const tokenRes = await deps.fetchImpl(`${config.endpoint}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: captured.code,
      redirect_uri: redirectUri,
      client_id: config.appId,
      code_verifier: pkce.codeVerifier,
      resource: config.resource,
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(
      `Logto token exchange failed: ${tokenRes.status} ${text}`,
    );
  }
  const json = (await tokenRes.json()) as TokenResponse;

  const bundle: TokenBundle = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: json.id_token,
    expires_in: json.expires_in,
    refreshed_at: Date.now(),
  };
  deps.saveTokens(bundle);
  return { bundle };
}
