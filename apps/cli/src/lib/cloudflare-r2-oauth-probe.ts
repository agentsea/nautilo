import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

const CLOUDFLARE_OAUTH_ISSUER = "https://dash.cloudflare.com";
export const CLOUDFLARE_OAUTH_AUTHORIZATION_ENDPOINT =
  "https://dash.cloudflare.com/oauth2/auth";
export const CLOUDFLARE_OAUTH_TOKEN_ENDPOINT =
  "https://dash.cloudflare.com/oauth2/token";
export const CLOUDFLARE_OAUTH_REVOKE_ENDPOINT =
  "https://dash.cloudflare.com/oauth2/revoke";
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI =
  "http://127.0.0.1:43879/callback";
const CLOUDFLARE_OAUTH_PROBE_CALLBACK_PORT = 43_879;

const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const OAUTH_SCOPE = /^\S{1,256}$/;
const OPAQUE_PARENT_ACCESS_KEY_ID = /^\S{1,512}$/;
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const OBJECT_PREFIX = "nautilo-oauth-probe/";

const SUCCESS_HTML = "<!doctype html><title>Cloudflare connected</title><p>Cloudflare connected. Return to the terminal.</p>";
const FAILURE_HTML = "<!doctype html><title>Cloudflare connection rejected</title><p>The callback was not accepted. Return to the terminal.</p>";

export type CloudflareR2OAuthProbeCode =
  | "invalid-input"
  | "callback-unavailable"
  | "callback-timeout"
  | "authorization-denied"
  | "callback-invalid"
  | "browser-open-failed"
  | "token-exchange-failed"
  | "scope-mismatch"
  | "token-verification-failed"
  | "oauth-token-not-r2-parent"
  | "bucket-name-collision"
  | "bucket-create-failed"
  | "temporary-credentials-failed"
  | "s3-session-failed"
  | "refresh-failed"
  | "cleanup-failed"
  | "revocation-failed"
  | "passed";

export type CloudflareR2OAuthProbeResult = Readonly<{
  outcome: "passed" | "failed";
  code: CloudflareR2OAuthProbeCode;
  bucketAbsent: boolean;
  authorizationRevoked: boolean;
}>;

export interface CloudflareR2SessionPort {
  put(input: { readonly key: string; readonly body: Uint8Array }): Promise<void>;
  head(input: { readonly key: string }): Promise<number>;
  get(input: { readonly key: string }): Promise<Uint8Array>;
  delete(input: { readonly key: string }): Promise<void>;
}

export interface CloudflareR2SessionCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

export interface CloudflareR2SessionRequest {
  /** Account-scoped Cloudflare R2 S3 endpoint. */
  readonly endpoint: string;
  /** The generated, disposable bucket. Never derive this from an object key. */
  readonly bucket: string;
  readonly credentials: CloudflareR2SessionCredentials;
}

export interface CloudflareOAuthCallbackHandle {
  readonly callback: Promise<
    | { readonly outcome: "code"; readonly code: string }
    | { readonly outcome: "denied" | "invalid" | "timeout" }
  >;
  close(): Promise<void>;
}

export interface CloudflareR2OAuthProbeOptions {
  readonly clientId: string;
  readonly accountId: string;
  /** Exact opaque scope ID returned by Cloudflare's OAuth scopes API. */
  readonly r2WriteScope: string;
  readonly openBrowser: (url: string) => void | Promise<void>;
  readonly createSession: (
    request: CloudflareR2SessionRequest,
  ) => CloudflareR2SessionPort | Promise<CloudflareR2SessionPort>;
  readonly fetch?: typeof globalThis.fetch;
  readonly startCallback?: (
    expectedState: string,
  ) => Promise<CloudflareOAuthCallbackHandle | null>;
  readonly randomBytes?: (size: number) => Uint8Array;
}

interface OAuthToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly scopes: readonly string[];
}

type ParsedToken =
  | Readonly<{ readonly outcome: "ok"; readonly token: OAuthToken }>
  | Readonly<{
      readonly outcome: "invalid";
      readonly accessToken?: string;
      readonly refreshToken?: string;
    }>
  | Readonly<{
      readonly outcome: "scope-mismatch";
      readonly accessToken: string;
      readonly refreshToken?: string;
    }>;

interface ApiResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

interface TokenRequestResult {
  readonly response: ApiResult;
  readonly parsed: ParsedToken;
}

function safeResult(
  outcome: "passed" | "failed",
  code: CloudflareR2OAuthProbeCode,
  bucketAbsent: boolean,
  authorizationRevoked: boolean,
): CloudflareR2OAuthProbeResult {
  return Object.freeze({ outcome, code, bucketAbsent, authorizationRevoked });
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function exactScopes(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual);
  return actualSet.size === expected.length &&
    actual.length === expected.length &&
    expected.every((scope) => actualSet.has(scope));
}

function parseToken(body: unknown, expectedScopes: readonly string[]): ParsedToken {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { outcome: "invalid" };
  }
  const value = body as Record<string, unknown>;
  const accessToken = typeof value["access_token"] === "string" &&
      value["access_token"].length > 0
    ? value["access_token"]
    : undefined;
  const refreshToken = value["refresh_token"];
  const retainedRefreshToken = typeof refreshToken === "string" && refreshToken.length > 0
    ? refreshToken
    : undefined;
  if (
    accessToken === undefined ||
    (refreshToken !== undefined &&
      (typeof refreshToken !== "string" || refreshToken.length === 0)) ||
    typeof value["token_type"] !== "string" || value["token_type"].toLowerCase() !== "bearer" ||
    typeof value["scope"] !== "string"
  ) {
    return {
      outcome: "invalid",
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(retainedRefreshToken === undefined ? {} : { refreshToken: retainedRefreshToken }),
    };
  }
  const scopes = value["scope"].split(/\s+/).filter(Boolean);
  if (!exactScopes(scopes, expectedScopes)) {
    return {
      outcome: "scope-mismatch",
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    };
  }
  return {
    outcome: "ok",
    token: {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      scopes,
    },
  };
}

async function boundedFetch(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRequest(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<ApiResult> {
  const response = await boundedFetch(fetchImpl, url, init);
  if (response === undefined) return { ok: false, status: 0, body: undefined };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

function bearer(accessToken: string): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${accessToken}` };
}

function apiEnvelope(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  return record["success"] === true ? record : undefined;
}

function tokenId(body: unknown): string | undefined {
  const envelope = apiEnvelope(body);
  const result = envelope?.["result"];
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const id = (result as Record<string, unknown>)["id"];
  return typeof id === "string" && OPAQUE_PARENT_ACCESS_KEY_ID.test(id) ? id : undefined;
}

function temporaryCredentials(body: unknown): CloudflareR2SessionCredentials | undefined {
  const envelope = apiEnvelope(body);
  const result = envelope?.["result"];
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const value = result as Record<string, unknown>;
  return typeof value["accessKeyId"] === "string" && value["accessKeyId"].length > 0 &&
      typeof value["secretAccessKey"] === "string" && value["secretAccessKey"].length > 0 &&
      typeof value["sessionToken"] === "string" && value["sessionToken"].length > 0
    ? {
        accessKeyId: value["accessKeyId"],
        secretAccessKey: value["secretAccessKey"],
        sessionToken: value["sessionToken"],
      }
    : undefined;
}

export async function startCloudflareOAuthProbeCallback(
  expectedState: string,
): Promise<CloudflareOAuthCallbackHandle | null> {
  let settled = false;
  let consumed = false;
  let resolveCallback!: (
    value:
      | { readonly outcome: "code"; readonly code: string }
      | { readonly outcome: "denied" | "invalid" | "timeout" },
  ) => void;
  const callback = new Promise<
    | { readonly outcome: "code"; readonly code: string }
    | { readonly outcome: "denied" | "invalid" | "timeout" }
  >((resolve) => { resolveCallback = resolve; });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI);
    if (request.method !== "GET" || url.pathname !== "/callback" || consumed) {
      response.writeHead(consumed ? 409 : 404, { "content-type": "text/html; charset=utf-8" });
      response.end(FAILURE_HTML);
      return;
    }
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    const issuer = url.searchParams.get("iss");
    const validIssuer = issuer === null || issuer === CLOUDFLARE_OAUTH_ISSUER;
    const validState = states.length === 1 && equalSecret(states[0] ?? "", expectedState);
    const validChoice = codes.length + errors.length === 1;
    const code = codes[0];
    if (!validState || !validIssuer || !validChoice || (codes.length === 1 && !code)) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(FAILURE_HTML);
      return;
    }
    consumed = true;
    const result = errors.length === 1
      ? { outcome: "denied" as const }
      : { outcome: "code" as const, code: code! };
    response.writeHead(result.outcome === "code" ? 200 : 400, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(result.outcome === "code" ? SUCCESS_HTML : FAILURE_HTML);
    if (!settled) {
      settled = true;
      resolveCallback(result);
    }
  });

  const listening = await new Promise<boolean>((resolve) => {
    const onError = () => resolve(false);
    server.once("error", onError);
    server.listen(CLOUDFLARE_OAUTH_PROBE_CALLBACK_PORT, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(true);
    });
  });
  if (!listening) return null;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      consumed = true;
      resolveCallback({ outcome: "timeout" });
    }
  }, CALLBACK_TIMEOUT_MS);
  return {
    callback,
    close: async () => {
      clearTimeout(timer);
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

async function requestToken(
  fetchImpl: typeof globalThis.fetch,
  body: URLSearchParams,
  expectedScopes: readonly string[],
): Promise<TokenRequestResult> {
  const response = await jsonRequest(fetchImpl, CLOUDFLARE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return {
    response,
    parsed: response.ok ? parseToken(response.body, expectedScopes) : { outcome: "invalid" },
  };
}

function isAuthoritativeRevocationDenial(result: TokenRequestResult): boolean {
  if (result.response.status !== 400) return false;
  const body = result.response.body;
  return typeof body === "object" && body !== null && !Array.isArray(body) &&
    (body as Record<string, unknown>)["error"] === "invalid_grant";
}

function isAuthoritativeAccessTokenRejection(result: ApiResult): boolean {
  if (result.status !== 401 && result.status !== 403) return false;
  const body = result.body;
  return typeof body === "object" && body !== null && !Array.isArray(body) &&
    (body as Record<string, unknown>)["success"] === false;
}

function isAuthoritativeBucketAbsence(result: ApiResult): boolean {
  if (result.status !== 404) return false;
  const body = result.body;
  return typeof body === "object" && body !== null && !Array.isArray(body) &&
    (body as Record<string, unknown>)["success"] === false;
}

async function revoke(
  fetchImpl: typeof globalThis.fetch,
  clientId: string,
  token: string,
): Promise<boolean> {
  const response = await boundedFetch(fetchImpl, CLOUDFLARE_OAUTH_REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token }),
  });
  return response?.ok === true;
}

function validOptions(
  clientId: string,
  accountId: string,
  r2WriteScope: string,
): boolean {
  return CLIENT_ID.test(clientId) &&
    ACCOUNT_ID.test(accountId) &&
    OAUTH_SCOPE.test(r2WriteScope) &&
    r2WriteScope !== "openid" &&
    r2WriteScope !== "offline_access";
}

export async function runCloudflareR2OAuthProbe(
  options: CloudflareR2OAuthProbeOptions,
): Promise<CloudflareR2OAuthProbeResult> {
  // This is an effectful qualification workflow. Snapshot all caller-owned
  // capabilities and scalars once, before the first await, so a callback cannot
  // redirect later cleanup or provider effects.
  const clientId = options.clientId;
  const accountId = options.accountId;
  const r2WriteScope = options.r2WriteScope;
  const openBrowser = options.openBrowser;
  const createSession = options.createSession;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const startCallback = options.startCallback ?? startCloudflareOAuthProbeCallback;
  const random = options.randomBytes ?? randomBytes;
  if (!validOptions(clientId, accountId, r2WriteScope)) {
    return safeResult("failed", "invalid-input", true, false);
  }
  const state = base64url(random(32));
  const verifier = base64url(random(64));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // Cloudflare OAuth client scopes are the API permissions selected when the
  // client is registered. Standard OIDC scopes are not implicitly allowed for
  // an API-only client and cause authorization to fail before consent.
  const expectedScopes = Object.freeze([r2WriteScope]);
  const bucketName = `nautilo-oauth-probe-${Buffer.from(random(8)).toString("hex")}`;
  if (!BUCKET_NAME.test(bucketName)) return safeResult("failed", "invalid-input", true, false);

  let callback: CloudflareOAuthCallbackHandle | null;
  try {
    callback = await startCallback(state);
  } catch {
    callback = null;
  }
  if (callback === null) return safeResult("failed", "callback-unavailable", true, false);

  let currentAccessToken: string | undefined;
  let currentRefreshToken: string | undefined;
  let session: CloudflareR2SessionPort | undefined;
  let objectKey: string | undefined;
  let bucketCreationAttempted = false;
  let bucketAbsent = true;
  let authorizationRevoked = false;
  let failureCode: CloudflareR2OAuthProbeCode | undefined;

  try {
    const authorize = new URL(CLOUDFLARE_OAUTH_AUTHORIZATION_ENDPOINT);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI);
    authorize.searchParams.set("scope", expectedScopes.join(" "));
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    try {
      await openBrowser(authorize.toString());
    } catch {
      return safeResult("failed", "browser-open-failed", true, false);
    }

    const accepted = await callback.callback.catch(() => ({ outcome: "invalid" as const }));
    if (accepted.outcome === "timeout") return safeResult("failed", "callback-timeout", true, false);
    if (accepted.outcome === "denied") return safeResult("failed", "authorization-denied", true, false);
    if (accepted.outcome !== "code") return safeResult("failed", "callback-invalid", true, false);
    await callback.close().catch(() => undefined);
    callback = null;

    const initial = await requestToken(fetchImpl, new URLSearchParams({
      grant_type: "authorization_code",
      code: accepted.code,
      redirect_uri: CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }), expectedScopes);
    if (initial.parsed.outcome === "invalid") {
      currentAccessToken = initial.parsed.accessToken;
      currentRefreshToken = initial.parsed.refreshToken;
      failureCode = "token-exchange-failed";
    } else if (initial.parsed.outcome === "scope-mismatch") {
      currentAccessToken = initial.parsed.accessToken;
      currentRefreshToken = initial.parsed.refreshToken;
      failureCode = "scope-mismatch";
    } else {
      currentAccessToken = initial.parsed.token.accessToken;
      currentRefreshToken = initial.parsed.token.refreshToken;
    }

    const initialAccessToken = currentAccessToken;
    if (failureCode === undefined && initialAccessToken !== undefined) {
      const verified = await jsonRequest(fetchImpl, `${CLOUDFLARE_API_BASE}/user/tokens/verify`, {
      method: "GET",
      headers: bearer(initialAccessToken),
      });
      const parentAccessKeyId = verified.ok ? tokenId(verified.body) : undefined;
      if (parentAccessKeyId === undefined) {
        failureCode = "token-verification-failed";
      } else {
        const bucketUrl = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`;
        const beforeCreate = await jsonRequest(fetchImpl, bucketUrl, {
          method: "GET",
          headers: bearer(initialAccessToken),
        });
        if (!isAuthoritativeBucketAbsence(beforeCreate)) {
          failureCode = beforeCreate.status === 200 && apiEnvelope(beforeCreate.body) !== undefined
            ? "bucket-name-collision"
            : "bucket-create-failed";
          if (failureCode === "bucket-name-collision") bucketAbsent = false;
        } else {
          bucketCreationAttempted = true;
          bucketAbsent = false;
          const created = await jsonRequest(fetchImpl, `${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets`, {
            method: "POST",
            headers: { ...bearer(initialAccessToken), "content-type": "application/json" },
            body: JSON.stringify({ name: bucketName, storageClass: "Standard" }),
          });
          const createdEnvelope = apiEnvelope(created.body);
          const createdResult = createdEnvelope?.["result"];
          const createdName = typeof createdResult === "object" && createdResult !== null && !Array.isArray(createdResult)
            ? (createdResult as Record<string, unknown>)["name"]
            : undefined;
          if (!created.ok || createdName !== bucketName) {
            failureCode = "bucket-create-failed";
          } else {
            const temporary = await jsonRequest(
              fetchImpl,
              `${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/temp-access-credentials`,
              {
                method: "POST",
                headers: { ...bearer(initialAccessToken), "content-type": "application/json" },
                body: JSON.stringify({
                  bucket: bucketName,
                  parentAccessKeyId,
                  permission: "object-read-write",
                  ttlSeconds: 900,
                  prefixes: [OBJECT_PREFIX],
                }),
              },
            );
            if (temporary.status === 400 || temporary.status === 403) {
              // The probe's only undocumented substitution is the OAuth token ID as
              // parentAccessKeyId. A rejection here is the bounded no-go signal.
              failureCode = "oauth-token-not-r2-parent";
            } else {
              const credentials = temporaryCredentials(temporary.body);
              if (credentials === undefined) {
                failureCode = "temporary-credentials-failed";
              } else {
                const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
                try {
                  session = await createSession({ endpoint, bucket: bucketName, credentials });
                  objectKey = `${OBJECT_PREFIX}${Buffer.from(random(8)).toString("hex")}.bin`;
                  const body = random(64);
                  await session.put({ key: objectKey, body });
                  if (await session.head({ key: objectKey }) !== body.byteLength) throw new Error("head");
                  const downloaded = await session.get({ key: objectKey });
                  if (!Buffer.from(downloaded).equals(Buffer.from(body))) throw new Error("get");
                  await session.delete({ key: objectKey });
                  objectKey = undefined;
                } catch {
                  failureCode = "s3-session-failed";
                }
              }
            }
          }
        }
      }
    }

    if (
      currentRefreshToken !== undefined &&
      failureCode !== "scope-mismatch" &&
      failureCode !== "token-exchange-failed"
    ) {
      const refreshed = await requestToken(fetchImpl, new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: currentRefreshToken,
        client_id: clientId,
      }), expectedScopes);
      if (refreshed.parsed.outcome !== "ok") {
        failureCode ??= "refresh-failed";
      } else {
        currentAccessToken = refreshed.parsed.token.accessToken;
        currentRefreshToken = refreshed.parsed.token.refreshToken;
      }
    }
  } finally {
    if (callback !== null) await callback.close().catch(() => undefined);
    if (session !== undefined && objectKey !== undefined) {
      await session.delete({ key: objectKey }).catch(() => undefined);
      objectKey = undefined;
    }
    if (bucketCreationAttempted && currentAccessToken !== undefined) {
      const deleted = await jsonRequest(
        fetchImpl,
        `${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`,
        { method: "DELETE", headers: bearer(currentAccessToken) },
      );
      if (deleted.ok && apiEnvelope(deleted.body) !== undefined) {
        const observed = await jsonRequest(
          fetchImpl,
          `${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets/${bucketName}`,
          { method: "GET", headers: bearer(currentAccessToken) },
        );
        bucketAbsent = isAuthoritativeBucketAbsence(observed);
      }
    }
    if (currentAccessToken !== undefined || currentRefreshToken !== undefined) {
      const accessRevoked = currentAccessToken === undefined
        ? true
        : await revoke(fetchImpl, clientId, currentAccessToken);
      let refreshRevoked = true;
      let refreshRejected = true;
      if (currentRefreshToken !== undefined) {
        refreshRevoked = await revoke(fetchImpl, clientId, currentRefreshToken);
        const afterRevoke = await requestToken(fetchImpl, new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: currentRefreshToken,
          client_id: clientId,
        }), expectedScopes);
        refreshRejected = isAuthoritativeRevocationDenial(afterRevoke);
      }
      const accessAfterRevoke = currentAccessToken === undefined
        ? undefined
        : await jsonRequest(fetchImpl, `${CLOUDFLARE_API_BASE}/user/tokens/verify`, {
            method: "GET",
            headers: bearer(currentAccessToken),
          });
      authorizationRevoked = accessRevoked && refreshRevoked && refreshRejected &&
        (accessAfterRevoke === undefined || isAuthoritativeAccessTokenRejection(accessAfterRevoke));
    }
  }

  if (failureCode === "bucket-name-collision") {
    return safeResult("failed", failureCode, false, authorizationRevoked);
  }
  if (!bucketAbsent) return safeResult("failed", "cleanup-failed", false, authorizationRevoked);
  if (!authorizationRevoked) return safeResult("failed", "revocation-failed", true, false);
  if (failureCode !== undefined) return safeResult("failed", failureCode, true, true);
  return safeResult("passed", "passed", true, true);
}
