import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { RailwayGraphqlTransport } from "./transport";
import type { RailwayFetch } from "./types";

/** Railway's OAuth discovery document lives below `/oauth`, not at the issuer root. */
export const RAILWAY_OAUTH_DISCOVERY_URL =
  "https://backboard.railway.com/oauth/.well-known/openid-configuration";
export const RAILWAY_OAUTH_ISSUER = "https://backboard.railway.com";
export const RAILWAY_OAUTH_AUTHORIZATION_ENDPOINT =
  "https://backboard.railway.com/oauth/auth";
export const RAILWAY_OAUTH_TOKEN_ENDPOINT =
  "https://backboard.railway.com/oauth/token";
/**
 * Nautilo CLI's registered Railway Native/Public OAuth identity. This ID is
 * intentionally public and ships in every build; no client secret exists.
 */
export const RAILWAY_OAUTH_CLIENT_ID = "rlwy_oaci_m3o2YCnliWf67k5awTIZ7HUW";
/** Live create/delete proof against a user-consented workspace; see RAILWAY-EVIDENCE.md. */
export const RAILWAY_OAUTH_MUTATION_SCOPE_QUALIFIED_AT = "2026-08-04" as const;

/** Memory-only authorization must not mint a refresh token that it cannot retain. */
export const RAILWAY_OAUTH_MEMORY_SCOPES = [
  "openid",
  "email",
  "profile",
  "workspace:admin",
] as const;

/** Durable authorization adds Railway's documented refresh-token scope. */
export const RAILWAY_OAUTH_DURABLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "workspace:admin",
] as const;

/**
 * Railway exact-matches native redirect URIs. This high fixed port must be
 * registered on the Nautilo native public client; it must never be replaced
 * at runtime with an unregistered ephemeral port.
 */
export const RAILWAY_OAUTH_REDIRECT_URI = "http://127.0.0.1:43877/callback";
export const RAILWAY_OAUTH_CALLBACK_PORT = 43_877;

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;
const MAX_CALLBACK_TIMEOUT_MS = 10 * 60_000;
const MAX_TOKEN_TIMEOUT_MS = 2 * 60_000;
const CALLBACK_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Railway connected</title></head><body><p>Railway connected. You can close this tab.</p></body></html>`;
const CALLBACK_FAILURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Railway connection not accepted</title></head><body><p>This callback was not accepted. Return to Nautilo for a safe repair step.</p></body></html>`;

export type RailwayOAuthFailureKind =
  | "callback-port-unavailable"
  | "callback-timeout"
  | "browser-open-failed"
  | "authorization-denied"
  | "callback-invalid"
  | "state-mismatch"
  | "issuer-mismatch"
  | "callback-replayed"
  | "token-exchange-failed"
  | "token-request-timeout"
  | "token-response-invalid"
  | "insufficient-scope"
  | "reauthorization-required"
  | "refresh-failed"
  | "refresh-revoked"
  | "refresh-conflict"
  | "credential-store-failed";

export type RailwayOAuthRepair =
  | "free-registered-callback-port"
  | "retry-browser-authorization"
  | "run-in-interactive-terminal"
  | "reauthorize-railway"
  | "retry-later"
  | "repair-credential-store";

export interface RailwayOAuthFailure {
  readonly kind: RailwayOAuthFailureKind;
  readonly repair: RailwayOAuthRepair;
}

export interface RailwayOAuthStoredCredential {
  readonly refreshToken: string;
  readonly generation: number;
}

/**
 * Exclusive authority over exactly one durable refresh slot. Implementations
 * must keep the lease exclusive until `release`, replace the leased generation
 * atomically, and make `clear` conditional on the same still-current lease.
 */
export interface RailwayOAuthRefreshLease {
  readonly credential: RailwayOAuthStoredCredential | null;
  replace(credential: RailwayOAuthStoredCredential): Promise<"stored" | "stale-lease">;
  clear(): Promise<"cleared" | "stale-lease">;
  release(): Promise<void>;
}

/** No plaintext implementation is supplied by this package. */
export interface RailwayOAuthCredentialStore {
  acquireExclusiveRefreshLease(): Promise<RailwayOAuthRefreshLease>;
}

export type RailwayOAuthAuthorizationResult =
  | {
      readonly outcome: "authorized";
      readonly transport: RailwayGraphqlTransport;
      readonly expiresAt: number;
      readonly persistence: "memory-only" | "os-credential-store";
    }
  | { readonly outcome: "failure"; readonly failure: RailwayOAuthFailure };

export interface RailwayOAuthAuthorizeOptions {
  readonly clientId?: string | undefined;
  readonly interactive: boolean;
  readonly fetch?: RailwayFetch | undefined;
  readonly openBrowser?: ((url: string) => void | Promise<void>) | undefined;
  readonly credentialStore?: RailwayOAuthCredentialStore | undefined;
  readonly callbackTimeoutMs?: number | undefined;
  readonly tokenTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** Unit-test seam. Production always binds the pinned fixed redirect. */
  readonly startLoopback?: RailwayOAuthLoopbackFactory | undefined;
}

export type RailwayOAuthCallback =
  | { readonly outcome: "code"; readonly code: string; readonly state: string; readonly issuer: string }
  | { readonly outcome: "denied"; readonly state: string; readonly issuer: string }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "state-mismatch" }
  | { readonly outcome: "issuer-mismatch" }
  | { readonly outcome: "timeout" }
  | { readonly outcome: "replayed" };

export interface RailwayOAuthLoopbackHandle {
  readonly callback: Promise<RailwayOAuthCallback>;
  close(): Promise<void>;
}

export interface RailwayOAuthLoopbackRequest {
  readonly timeoutMs: number;
  readonly expectedState: string;
  readonly expectedIssuer: typeof RAILWAY_OAUTH_ISSUER;
}

export type RailwayOAuthLoopbackFactory = (
  request: RailwayOAuthLoopbackRequest,
) => Promise<
  | { readonly outcome: "listening"; readonly handle: RailwayOAuthLoopbackHandle }
  | { readonly outcome: "port-unavailable" }
>;

interface RailwayTokenPayload {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresIn: number;
  readonly scopes: readonly string[];
}

type TokenRequestResult =
  | { readonly outcome: "success"; readonly token: RailwayTokenPayload }
  | {
      readonly outcome: "failure";
      readonly kind: "network" | "timeout" | "invalid-grant" | "invalid-response" | "http";
    };

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

export function createRailwayPkce(): {
  readonly verifier: string;
  readonly challenge: string;
} {
  const verifier = base64url(randomBytes(64));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
  };
}

export function createRailwayOAuthState(): string {
  return base64url(randomBytes(32));
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

type ParsedCallback =
  | { readonly outcome: "accepted"; readonly callback: RailwayOAuthCallback }
  | { readonly outcome: "rejected"; readonly reason: "invalid" | "state-mismatch" | "issuer-mismatch" }
  | { readonly outcome: "replayed" };

function parseCallback(
  url: URL,
  consumed: boolean,
  expectedState: string,
  expectedIssuer: string,
): ParsedCallback {
  if (consumed) return { outcome: "replayed" };
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] === undefined || !equalSecret(states[0], expectedState)) {
    return { outcome: "rejected", reason: "state-mismatch" };
  }
  const issuers = url.searchParams.getAll("iss");
  if (issuers.length !== 1 || issuers[0] !== expectedIssuer) {
    return { outcome: "rejected", reason: "issuer-mismatch" };
  }
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (codes.length + errors.length !== 1 || codes.length > 1 || errors.length > 1) {
    return { outcome: "rejected", reason: "invalid" };
  }
  if (errors.length === 1) {
    return {
      outcome: "accepted",
      callback: { outcome: "denied", state: states[0], issuer: issuers[0] },
    };
  }
  const code = codes[0];
  if (code === undefined || code.length === 0) {
    return { outcome: "rejected", reason: "invalid" };
  }
  return {
    outcome: "accepted",
    callback: { outcome: "code", code, state: states[0], issuer: issuers[0] },
  };
}

export async function startRailwayOAuthLoopback(
  request: RailwayOAuthLoopbackRequest,
): Promise<
  | { readonly outcome: "listening"; readonly handle: RailwayOAuthLoopbackHandle }
  | { readonly outcome: "port-unavailable" }
> {
  let resolveCallback!: (callback: RailwayOAuthCallback) => void;
  const callback = new Promise<RailwayOAuthCallback>((resolve) => {
    resolveCallback = resolve;
  });
  let consumed = false;
  let settled = false;

  const server: Server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", RAILWAY_OAUTH_REDIRECT_URI);
    if (incoming.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not the Railway OAuth callback endpoint.");
      return;
    }
    const parsed = parseCallback(
      url,
      consumed,
      request.expectedState,
      request.expectedIssuer,
    );
    if (parsed.outcome === "replayed") {
      response.writeHead(409, { "content-type": "text/html; charset=utf-8" });
      response.end(CALLBACK_FAILURE_HTML);
      return;
    }
    if (parsed.outcome === "rejected") {
      response.writeHead(400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(CALLBACK_FAILURE_HTML);
      return;
    }

    consumed = true;
    const accepted = parsed.callback;
    response.writeHead(accepted.outcome === "code" ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(accepted.outcome === "code" ? CALLBACK_SUCCESS_HTML : CALLBACK_FAILURE_HTML);
    if (!settled) {
      settled = true;
      resolveCallback(accepted);
    }
  });

  const listening = await new Promise<boolean>((resolve) => {
    const onError = () => resolve(false);
    server.once("error", onError);
    server.listen(RAILWAY_OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(true);
    });
  });
  if (!listening) {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    return { outcome: "port-unavailable" };
  }

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      consumed = true;
      resolveCallback({ outcome: "timeout" });
    }
  }, request.timeoutMs);

  return {
    outcome: "listening",
    handle: {
      callback,
      close: async () => {
        clearTimeout(timer);
        if (!server.listening) return;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    },
  };
}

function authorizationUrl(
  clientId: string,
  state: string,
  challenge: string,
  scopes: readonly string[],
): string {
  const url = new URL(RAILWAY_OAUTH_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", RAILWAY_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", scopes.join(" "));
  // Railway workspace selection is consent-driven, so even memory-only mode
  // keeps consent explicit while intentionally omitting offline_access.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

function tokenPayload(value: unknown): RailwayTokenPayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record["access_token"] !== "string" ||
    record["access_token"].length === 0 ||
    typeof record["token_type"] !== "string" ||
    record["token_type"].toLowerCase() !== "bearer" ||
    typeof record["scope"] !== "string" ||
    typeof record["expires_in"] !== "number" ||
    !Number.isFinite(record["expires_in"]) ||
    record["expires_in"] <= 0
  ) {
    return undefined;
  }
  if (record["refresh_token"] !== undefined && typeof record["refresh_token"] !== "string") {
    return undefined;
  }
  return {
    accessToken: record["access_token"],
    expiresIn: record["expires_in"],
    scopes: record["scope"].split(/\s+/).filter((scope) => scope.length > 0),
    ...(typeof record["refresh_token"] === "string" && record["refresh_token"].length > 0
      ? { refreshToken: record["refresh_token"] }
      : {}),
  };
}

async function requestToken(
  fetchImpl: RailwayFetch,
  body: URLSearchParams,
  timeoutMs: number,
): Promise<TokenRequestResult> {
  const controller = new AbortController();
  const attempt = (async (): Promise<TokenRequestResult> => {
    let response: Response;
    try {
      response = await fetchImpl(RAILWAY_OAUTH_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
    } catch {
      return { outcome: "failure", kind: "network" };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      raw = undefined;
    }
    if (!response.ok) {
      const error = typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)["error"]
        : undefined;
      return {
        outcome: "failure",
        kind: error === "invalid_grant" ? "invalid-grant" : "http",
      };
    }
    const token = tokenPayload(raw);
    return token === undefined
      ? { outcome: "failure", kind: "invalid-response" }
      : { outcome: "success", token };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TokenRequestResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: "failure", kind: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failure(kind: RailwayOAuthFailureKind, repair: RailwayOAuthRepair): RailwayOAuthAuthorizationResult {
  return { outcome: "failure", failure: { kind, repair } };
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.round(value), maximum);
}

function exactScopes(token: RailwayTokenPayload, expected: readonly string[]): boolean {
  if (token.scopes.length !== expected.length) return false;
  const granted = new Set(token.scopes);
  return granted.size === expected.length && expected.every((scope) => granted.has(scope));
}

function validStoredCredential(
  credential: RailwayOAuthStoredCredential | null,
): credential is RailwayOAuthStoredCredential {
  return credential !== null && credential.refreshToken.length > 0 &&
    Number.isSafeInteger(credential.generation) && credential.generation > 0;
}

async function refreshAuthorization(
  clientId: string,
  lease: RailwayOAuthRefreshLease,
  fetchImpl: RailwayFetch,
  tokenTimeoutMs: number,
  now: () => number,
): Promise<RailwayOAuthAuthorizationResult> {
  const stored = lease.credential;
  if (!validStoredCredential(stored)) {
    return failure("credential-store-failed", "repair-credential-store");
  }
  const response = await requestToken(fetchImpl, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: clientId,
  }), tokenTimeoutMs);
  if (response.outcome === "failure") {
    if (response.kind === "timeout") {
      return failure("token-request-timeout", "retry-later");
    }
    if (response.kind === "invalid-grant") {
      let cleared: "cleared" | "stale-lease";
      try {
        cleared = await lease.clear();
      } catch {
        return failure("credential-store-failed", "repair-credential-store");
      }
      return cleared === "cleared"
        ? failure("refresh-revoked", "reauthorize-railway")
        : failure("refresh-conflict", "reauthorize-railway");
    }
    return failure(
      response.kind === "invalid-response" ? "token-response-invalid" : "refresh-failed",
      "retry-later",
    );
  }
  if (!exactScopes(response.token, RAILWAY_OAUTH_DURABLE_SCOPES)) {
    return failure("insufficient-scope", "reauthorize-railway");
  }
  if (response.token.refreshToken === undefined) {
    return failure("token-response-invalid", "reauthorize-railway");
  }
  let replaced: "stored" | "stale-lease";
  try {
    replaced = await lease.replace({
      refreshToken: response.token.refreshToken,
      generation: stored.generation + 1,
    });
  } catch {
    return failure("credential-store-failed", "repair-credential-store");
  }
  if (replaced === "stale-lease") {
    return failure("refresh-conflict", "reauthorize-railway");
  }
  return {
    outcome: "authorized",
    transport: new RailwayGraphqlTransport({ accessToken: response.token.accessToken, fetch: fetchImpl }),
    expiresAt: now() + Math.round(response.token.expiresIn * 1000),
    persistence: "os-credential-store",
  };
}

async function authorizeInteractively(
  options: RailwayOAuthAuthorizeOptions,
  clientId: string,
  scopes: readonly string[],
  lease: RailwayOAuthRefreshLease | undefined,
  fetchImpl: RailwayFetch,
  tokenTimeoutMs: number,
  now: () => number,
): Promise<RailwayOAuthAuthorizationResult> {
  if (!options.interactive) {
    return failure("reauthorization-required", "run-in-interactive-terminal");
  }
  if (options.openBrowser === undefined) {
    return failure("browser-open-failed", "retry-browser-authorization");
  }

  const pkce = createRailwayPkce();
  const state = createRailwayOAuthState();
  let loopback: Awaited<ReturnType<RailwayOAuthLoopbackFactory>>;
  try {
    loopback = await (options.startLoopback ?? startRailwayOAuthLoopback)({
      timeoutMs: boundedTimeout(
        options.callbackTimeoutMs,
        DEFAULT_CALLBACK_TIMEOUT_MS,
        MAX_CALLBACK_TIMEOUT_MS,
      ),
      expectedState: state,
      expectedIssuer: RAILWAY_OAUTH_ISSUER,
    });
  } catch {
    return failure("callback-port-unavailable", "free-registered-callback-port");
  }
  if (loopback.outcome === "port-unavailable") {
    return failure("callback-port-unavailable", "free-registered-callback-port");
  }

  let closed = false;
  try {
    try {
      await options.openBrowser(authorizationUrl(clientId, state, pkce.challenge, scopes));
    } catch {
      return failure("browser-open-failed", "retry-browser-authorization");
    }

    const callback = await loopback.handle.callback;
    if (callback.outcome === "replayed") {
      return failure("callback-replayed", "retry-browser-authorization");
    }
    if (callback.outcome === "timeout") {
      return failure("callback-timeout", "retry-browser-authorization");
    }
    if (callback.outcome === "invalid") {
      return failure("callback-invalid", "retry-browser-authorization");
    }
    if (callback.outcome === "state-mismatch") {
      return failure("state-mismatch", "retry-browser-authorization");
    }
    if (callback.outcome === "issuer-mismatch") {
      return failure("issuer-mismatch", "retry-browser-authorization");
    }
    if (!equalSecret(callback.state, state)) {
      return failure("state-mismatch", "retry-browser-authorization");
    }
    if (callback.issuer !== RAILWAY_OAUTH_ISSUER) {
      return failure("issuer-mismatch", "retry-browser-authorization");
    }
    if (callback.outcome === "denied") {
      return failure("authorization-denied", "retry-browser-authorization");
    }

    // Stop accepting callbacks before the single-use code leaves loopback memory.
    try {
      await loopback.handle.close();
      closed = true;
    } catch {
      return failure("callback-invalid", "retry-browser-authorization");
    }

    const response = await requestToken(fetchImpl, new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: RAILWAY_OAUTH_REDIRECT_URI,
      client_id: clientId,
      code_verifier: pkce.verifier,
    }), tokenTimeoutMs);
    if (response.outcome === "failure") {
      if (response.kind === "timeout") {
        return failure("token-request-timeout", "retry-browser-authorization");
      }
      return failure(
        response.kind === "invalid-response" ? "token-response-invalid" : "token-exchange-failed",
        "retry-browser-authorization",
      );
    }
    if (!exactScopes(response.token, scopes)) {
      return failure("insufficient-scope", "reauthorize-railway");
    }

    if (lease === undefined) {
      if (response.token.refreshToken !== undefined) {
        return failure("token-response-invalid", "reauthorize-railway");
      }
      return {
        outcome: "authorized",
        transport: new RailwayGraphqlTransport({ accessToken: response.token.accessToken, fetch: fetchImpl }),
        expiresAt: now() + Math.round(response.token.expiresIn * 1000),
        persistence: "memory-only",
      };
    }

    if (response.token.refreshToken === undefined) {
      return failure("token-response-invalid", "reauthorize-railway");
    }
    let replaced: "stored" | "stale-lease";
    try {
      replaced = await lease.replace({
        refreshToken: response.token.refreshToken,
        generation: 1,
      });
    } catch {
      return failure("credential-store-failed", "repair-credential-store");
    }
    if (replaced === "stale-lease") {
      return failure("refresh-conflict", "reauthorize-railway");
    }
    return {
      outcome: "authorized",
      transport: new RailwayGraphqlTransport({ accessToken: response.token.accessToken, fetch: fetchImpl }),
      expiresAt: now() + Math.round(response.token.expiresIn * 1000),
      persistence: "os-credential-store",
    };
  } finally {
    if (!closed) {
      await loopback.handle.close().catch(() => undefined);
    }
  }
}

/**
 * Acquires a Railway bearer token without accepting PATs, Railway CLI state,
 * client secrets, or plaintext refresh-token persistence.
 */
export async function authorizeRailwayOAuth(
  options: RailwayOAuthAuthorizeOptions,
): Promise<RailwayOAuthAuthorizationResult> {
  const configuredClientId = options.clientId?.trim();
  const clientId = configuredClientId === undefined || configuredClientId.length === 0
    ? RAILWAY_OAUTH_CLIENT_ID
    : configuredClientId;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const tokenTimeoutMs = boundedTimeout(
    options.tokenTimeoutMs,
    DEFAULT_TOKEN_TIMEOUT_MS,
    MAX_TOKEN_TIMEOUT_MS,
  );

  if (options.credentialStore === undefined) {
    return await authorizeInteractively(
      options,
      clientId,
      RAILWAY_OAUTH_MEMORY_SCOPES,
      undefined,
      fetchImpl,
      tokenTimeoutMs,
      now,
    );
  }

  let lease: RailwayOAuthRefreshLease;
  try {
    lease = await options.credentialStore.acquireExclusiveRefreshLease();
  } catch {
    return failure("credential-store-failed", "repair-credential-store");
  }
  let result: RailwayOAuthAuthorizationResult;
  try {
    result = lease.credential !== null
      ? await refreshAuthorization(clientId, lease, fetchImpl, tokenTimeoutMs, now)
      : await authorizeInteractively(
          options,
          clientId,
          RAILWAY_OAUTH_DURABLE_SCOPES,
          lease,
          fetchImpl,
          tokenTimeoutMs,
          now,
        );
  } catch {
    result = failure("credential-store-failed", "repair-credential-store");
  }
  try {
    await lease.release();
  } catch {
    return failure("credential-store-failed", "repair-credential-store");
  }
  return result;
}
