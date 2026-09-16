/**
 * M101 Phase 5 — renderer-triggerable OIDC step-up: same PKCE + loopback
 * pattern as `sign-in.ts`, but `prompt=login` + `max_age` forces a
 * fresh credential at the IdP so the server can treat the returned JWT
 * `iat` as a recent re-auth signal.
 *
 * Dependency-injected (no Electron imports) for hermetic unit tests.
 */
import type { LoopbackHandle } from "./loopback-server";
import type { TokenBundle } from "./token-store";

export interface StepUpDeps {
  openAuthUrl: (url: string) => Promise<{ closeAuthSurface: () => void }>;
  startLoopback: () => Promise<LoopbackHandle>;
  fetchImpl: typeof fetch;
  /** Save the new bundle (refresh token rotation may issue a new RT). */
  saveTokens: (bundle: TokenBundle) => Promise<void>;
  /** Logto config (endpoint, clientId for desktop, resource). */
  config: { endpoint: string; clientId: string; resource: string };
  /** Generate PKCE pair (mockable). */
  generatePkce: () => Promise<{ verifier: string; challenge: string }>;
  /** Generate random `state`. */
  generateState: () => string;
  /**
   * When the authorize scope omits `offline_access`, Logto may omit
   * `refresh_token` / `id_token` on the code exchange — merge from the
   * prior persisted bundle so `TokenBundle` invariants still hold.
   */
  getExistingTokenBundle?: () => Promise<TokenBundle | null>;
}

export interface StepUpResult {
  accessToken: string;
  /** Unix seconds when the new access token was issued (its `iat` if known, else now). */
  issuedAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stepUpCancelledError(cause: unknown): Error {
  const err = new Error("step_up_cancelled") as Error & {
    code: "cancelled";
    cause?: unknown;
  };
  err.code = "cancelled";
  err.cause = cause;
  return err;
}

export async function runStepUp(
  deps: StepUpDeps,
  opts?: { maxAgeSeconds?: number },
): Promise<StepUpResult> {
  const maxAgeSeconds = opts?.maxAgeSeconds ?? 60;
  const pkce = await deps.generatePkce();
  const state = deps.generateState();

  const loopback = await deps.startLoopback();
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;

  const authUrl = new URL(`${deps.config.endpoint}/oidc/auth`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", deps.config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("resource", deps.config.resource);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "login");
  authUrl.searchParams.set("max_age", String(maxAgeSeconds));

  const { closeAuthSurface } = await deps.openAuthUrl(authUrl.toString());

  let captured: { code: string; state: string };
  try {
    try {
      captured = await loopback.awaitCallback;
    } catch (cause) {
      throw stepUpCancelledError(cause);
    }
  } finally {
    loopback.shutdown();
    closeAuthSurface();
  }

  if (captured.state !== state) {
    throw new Error(
      "OIDC state mismatch — possible CSRF; aborting step-up",
    );
  }

  const tokenRes = await deps.fetchImpl(`${deps.config.endpoint}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: captured.code,
      redirect_uri: redirectUri,
      client_id: deps.config.clientId,
      code_verifier: pkce.verifier,
      resource: deps.config.resource,
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(
      `Logto token exchange failed: ${tokenRes.status} ${text}`,
    );
  }
  const json = (await tokenRes.json()) as TokenResponse;

  const existing = (await deps.getExistingTokenBundle?.()) ?? null;
  const refreshToken = json.refresh_token ?? existing?.refresh_token;
  const idToken = json.id_token ?? existing?.id_token;
  if (!refreshToken || !idToken) {
    throw new Error(
      "Logto token exchange missing refresh_token or id_token and no persisted bundle to merge",
    );
  }

  const bundle: TokenBundle = {
    access_token: json.access_token,
    refresh_token: refreshToken,
    id_token: idToken,
    expires_in: json.expires_in,
    refreshed_at: Date.now(),
  };
  await deps.saveTokens(bundle);

  const payload = decodeJwtPayload(json.access_token);
  const iatRaw = payload["iat"];
  const issuedAt =
    typeof iatRaw === "number" && Number.isFinite(iatRaw)
      ? iatRaw
      : Math.floor(Date.now() / 1000);

  return { accessToken: json.access_token, issuedAt };
}
