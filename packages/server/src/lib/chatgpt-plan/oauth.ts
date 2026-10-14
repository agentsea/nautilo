import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
// RFC 7636 recommends 32 octets of entropy for the verifier. State and nonce
// use the same cryptographically random entropy, independently generated.
const RANDOM_BYTES = 32;

export type ChatGPTPlanErrorCode =
  | "authorization_invalid" | "authorization_denied" | "authorization_expired"
  | "registration_incomplete" | "identity_invalid" | "plan_permission_missing"
  | "reconnect_required" | "provider_unavailable" | "token_response_invalid"
  | "credential_conflict" | "credential_unavailable" | "model_unavailable";

/** Provider response bodies and authorization URLs must never escape as errors. */
export class ChatGPTPlanError extends Error {
  constructor(readonly code: ChatGPTPlanErrorCode) {
    super(code);
    this.name = "ChatGPTPlanError";
  }
}

export interface ChatGPTRegistrationIdentity {
  readonly issuer: typeof CHATGPT_ISSUER;
  readonly subject: string;
  readonly clientId: string;
  readonly hostId: string;
  readonly email?: string;
}

/** Secret-bearing data: only the runtime custodian may persist or consume it. */
export interface ChatGPTSession {
  readonly identity: ChatGPTRegistrationIdentity;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly receivedAt: number;
}

export interface ChatGPTAuthorizationAttempt {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly hostId: string;
  readonly registration?: ChatGPTRegistrationIdentity;
}

export type OAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function random(): string { return randomBytes(RANDOM_BYTES).toString("base64url"); }

export function createChatGPTAuthorization(input: {
  hostId: string;
  port: number;
  registration?: ChatGPTRegistrationIdentity;
}): { attempt: ChatGPTAuthorizationAttempt; url: string } {
  if (!text(input.hostId) || !Number.isInteger(input.port) || input.port <= 0 || input.port > 65535
    || (input.registration && (input.registration.hostId !== input.hostId
      || input.registration.issuer !== CHATGPT_ISSUER
      || !text(input.registration.subject) || !text(input.registration.clientId)
      || input.registration.clientId === DYNAMIC_CLIENT_ID))) {
    throw new ChatGPTPlanError("authorization_invalid");
  }
  const attempt: ChatGPTAuthorizationAttempt = {
    redirectUri: `http://127.0.0.1:${input.port}/auth/callback`,
    state: random(), nonce: random(), verifier: random(), hostId: input.hostId,
    ...(input.registration ? { registration: input.registration } : {}),
  };
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.registration?.clientId ?? DYNAMIC_CLIENT_ID,
    ...(input.registration ? {} : { agent_name_hint: "Nautilo" }),
    ext_agent_host_id: input.hostId,
    response_type: "code", redirect_uri: attempt.redirectUri,
    scope: SCOPES, resource: CHATGPT_RESOURCE,
    state: attempt.state, nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
  }).toString();
  // Deliberately omit ID-token/email hints: the authorization URL crosses the
  // browser bridge and must contain no retained tokens or account information.
  return { attempt, url: url.toString() };
}

function single(params: URLSearchParams, name: string): string | null {
  if (params.getAll(name).length > 1) throw new ChatGPTPlanError("authorization_invalid");
  return params.get(name);
}

export function parseChatGPTCallback(attempt: ChatGPTAuthorizationAttempt, callback: URL): {
  code: string; clientId: string;
} {
  const expected = new URL(attempt.redirectUri);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
    || callback.hash || callback.username || callback.password) {
    throw new ChatGPTPlanError("authorization_invalid");
  }
  const state = single(callback.searchParams, "state");
  if (!state || !equal(state, attempt.state)) throw new ChatGPTPlanError("authorization_invalid");
  const error = single(callback.searchParams, "error");
  if (error) throw new ChatGPTPlanError(error === "access_denied" ? "authorization_denied" : "provider_unavailable");
  const clientId = single(callback.searchParams, "client_id") ?? attempt.registration?.clientId;
  if (!clientId || clientId === DYNAMIC_CLIENT_ID) throw new ChatGPTPlanError("registration_incomplete");
  if (attempt.registration && clientId !== attempt.registration.clientId) {
    throw new ChatGPTPlanError("identity_invalid");
  }
  const code = single(callback.searchParams, "code");
  if (!code) throw new ChatGPTPlanError("authorization_invalid");
  return { code, clientId };
}

export interface ChatGPTOAuthOptions {
  fetch?: OAuthFetch;
  /** Tests use a local JWKS; production discovers OpenAI's JWKS over HTTPS. */
  verificationKey?: JWTVerifyGetKey;
  now?: () => number;
}

export class ChatGPTOAuth {
  private readonly fetcher: OAuthFetch;
  private readonly now: () => number;
  private key: JWTVerifyGetKey | undefined;
  private discovery: Promise<{ jwksUri: URL; revocationEndpoint: URL }> | undefined;

  constructor(options: ChatGPTOAuthOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.key = options.verificationKey;
  }

  private async request(url: string | URL, init: RequestInit): Promise<Response> {
    try {
      // Credential redirects are never followed, including redirects back to
      // the same origin: endpoints come from the verified provider contract.
      return await this.fetcher(url, { ...init, redirect: "error" });
    } catch {
      throw new ChatGPTPlanError("provider_unavailable");
    }
  }

  private async discover(signal: AbortSignal) {
    this.discovery ??= (async () => {
      const response = await this.request(DISCOVERY_URL, { signal });
      if (!response.ok) throw new ChatGPTPlanError("provider_unavailable");
      const body: unknown = await response.json();
      if (!object(body) || body["issuer"] !== CHATGPT_ISSUER
        || !text(body["jwks_uri"]) || !text(body["revocation_endpoint"])) {
        throw new ChatGPTPlanError("provider_unavailable");
      }
      const jwksUri = new URL(body["jwks_uri"]);
      const revocationEndpoint = new URL(body["revocation_endpoint"]);
      for (const url of [jwksUri, revocationEndpoint]) {
        if (url.origin !== CHATGPT_ISSUER || url.username || url.password || url.hash) {
          throw new ChatGPTPlanError("provider_unavailable");
        }
      }
      return { jwksUri, revocationEndpoint };
    })().catch(() => {
      this.discovery = undefined;
      throw new ChatGPTPlanError("provider_unavailable");
    });
    return this.discovery;
  }

  private async tokens(form: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(TOKEN_URL, {
      method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" }, signal,
    });
    let body: unknown;
    try { body = await response.json(); } catch { throw new ChatGPTPlanError("token_response_invalid"); }
    if (!response.ok) {
      throw new ChatGPTPlanError(object(body) && body["error"] === "invalid_grant"
        ? "reconnect_required" : "provider_unavailable");
    }
    if (!object(body)) throw new ChatGPTPlanError("token_response_invalid");
    return body;
  }

  private async verifyIdentity(idToken: string, clientId: string, signal: AbortSignal, nonce?: string) {
    try {
      this.key ??= createRemoteJWKSet((await this.discover(signal)).jwksUri);
      const { payload } = await jwtVerify(idToken, this.key, {
        issuer: CHATGPT_ISSUER, audience: clientId,
        requiredClaims: ["sub", "exp", "iat"], currentDate: new Date(this.now()),
      });
      if (!text(payload.sub) || (nonce !== undefined && payload["nonce"] !== nonce)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload["azp"] !== clientId)
        || (payload["azp"] !== undefined && payload["azp"] !== clientId)) {
        throw new Error();
      }
      return { subject: payload.sub, ...(text(payload["email"]) ? { email: payload["email"] } : {}) };
    } catch { throw new ChatGPTPlanError("identity_invalid"); }
  }

  private async session(body: Record<string, unknown>, identity: ChatGPTRegistrationIdentity,
    signal: AbortSignal, input: { nonce?: string; previous?: ChatGPTSession }): Promise<ChatGPTSession> {
    const receivedAt = this.now();
    if (!text(body["access_token"]) || !text(body["refresh_token"])
      || typeof body["token_type"] !== "string" || body["token_type"].toLowerCase() !== "bearer"
      || !Number.isSafeInteger(body["expires_in"]) || (body["expires_in"] as number) <= 0) {
      throw new ChatGPTPlanError("token_response_invalid");
    }
    const scopes = text(body["scope"]) ? body["scope"].split(/\s+/) : input.previous?.scopes;
    if (!scopes || !["chatgpt.tokens.use.direct", "resource.invoke", "offline_access"].every(s => scopes.includes(s))) {
      throw new ChatGPTPlanError("plan_permission_missing");
    }
    const idToken = body["id_token"];
    if (idToken !== undefined && !text(idToken)) throw new ChatGPTPlanError("token_response_invalid");
    if (!idToken && !input.previous) throw new ChatGPTPlanError("identity_invalid");
    let verifiedIdentity = identity;
    if (text(idToken)) {
      const claims = await this.verifyIdentity(idToken, identity.clientId, signal, input.nonce);
      if (identity.subject && identity.subject !== claims.subject) throw new ChatGPTPlanError("identity_invalid");
      verifiedIdentity = { ...identity, ...claims };
    }
    const expiresAt = receivedAt + (body["expires_in"] as number) * 1000;
    if (!Number.isSafeInteger(expiresAt)) throw new ChatGPTPlanError("token_response_invalid");
    return { identity: verifiedIdentity, accessToken: body["access_token"], refreshToken: body["refresh_token"],
      idToken: (idToken) ?? input.previous!.idToken, scopes, expiresAt, receivedAt };
  }

  async exchange(attempt: ChatGPTAuthorizationAttempt, callback: URL, signal: AbortSignal): Promise<ChatGPTSession> {
    const { code, clientId } = parseChatGPTCallback(attempt, callback);
    const body = await this.tokens(new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code,
      code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: CHATGPT_RESOURCE,
    }), signal);
    return this.session(body, attempt.registration ?? {
      issuer: CHATGPT_ISSUER, subject: "", clientId, hostId: attempt.hostId,
    }, signal, { nonce: attempt.nonce });
  }

  async refresh(session: ChatGPTSession, signal: AbortSignal): Promise<ChatGPTSession> {
    const body = await this.tokens(new URLSearchParams({
      grant_type: "refresh_token", client_id: session.identity.clientId,
      refresh_token: session.refreshToken, resource: CHATGPT_RESOURCE,
    }), signal);
    return this.session(body, session.identity, signal, { previous: session });
  }

  async revoke(session: ChatGPTSession, signal: AbortSignal): Promise<boolean> {
    try {
      const { revocationEndpoint } = await this.discover(signal);
      const response = await this.request(revocationEndpoint, {
        method: "POST", signal, headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: session.refreshToken, token_type_hint: "refresh_token", client_id: session.identity.clientId }),
      });
      return response.status === 200;
    } catch { return false; }
  }
}
