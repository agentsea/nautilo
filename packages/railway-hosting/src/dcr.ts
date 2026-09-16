import {
  RAILWAY_OAUTH_REDIRECT_URI,
} from "./oauth";
import type { RailwayFetch } from "./types";

export const RAILWAY_DCR_ENDPOINT = "https://backboard.railway.com/oauth/register";
const RAILWAY_DCR_CLIENT_NAME = "Nautilo BYOC CLI";
export const RAILWAY_DCR_REQUEST = {
  client_name: RAILWAY_DCR_CLIENT_NAME,
  application_type: "native",
  redirect_uris: [RAILWAY_OAUTH_REDIRECT_URI],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code"],
  response_types: ["code"],
} as const;

const DEFAULT_DCR_TIMEOUT_MS = 30_000;
const MAX_DCR_TIMEOUT_MS = 2 * 60_000;

export interface RailwayDcrManagementCredential {
  /** Public client identifier. */
  readonly clientId: string;
  /** Server-issued RFC 7592 management URI; never constructed by Nautilo. */
  readonly registrationClientUri: string;
  /** Long-lived bearer credential. Never render, log, or serialize this record. */
  readonly registrationAccessToken: string;
}

/**
 * Injected secure authority for the RFC 7592 management credential. The
 * package supplies no file-backed implementation.
 */
export interface RailwayDcrSecureAuthority {
  store(credential: RailwayDcrManagementCredential): Promise<void>;
  load(clientId: string): Promise<RailwayDcrManagementCredential | null>;
  clear(clientId: string): Promise<void>;
}

export type RailwayDcrFailureKind =
  | "rate-limited"
  | "initial-access-token-required"
  | "registration-rejected"
  | "invalid-client"
  | "invalid-response"
  | "network-failure"
  | "request-timeout"
  | "secure-authority-failed"
  | "management-token-invalid"
  | "delete-forbidden"
  | "delete-unsupported"
  | "cleanup-failed";

export interface RailwayDcrFailure {
  readonly kind: RailwayDcrFailureKind;
  readonly httpStatus?: number | undefined;
  readonly retryAfterMs?: number | undefined;
}

export type RailwayDcrRegistrationResult =
  | {
      readonly outcome: "registered";
      readonly clientId: string;
      readonly initialAccessTokenUsed: false;
      readonly appType: "native-public";
    }
  | { readonly outcome: "failure"; readonly failure: RailwayDcrFailure };

export type RailwayDcrDeleteResult =
  | { readonly outcome: "deleted"; readonly clientId: string }
  | { readonly outcome: "failure"; readonly failure: RailwayDcrFailure };

export interface RailwayDcrOptions {
  readonly fetch?: RailwayFetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly authority: RailwayDcrSecureAuthority;
}

interface RailwayDcrResponse {
  readonly clientId: string;
  readonly registrationClientUri: string;
  readonly registrationAccessToken: string;
}

type BoundedResponse =
  | { readonly outcome: "response"; readonly response: Response }
  | { readonly outcome: "network-failure" }
  | { readonly outcome: "timeout" };

type BoundedJson =
  | { readonly outcome: "json"; readonly value: unknown }
  | { readonly outcome: "invalid-json" }
  | { readonly outcome: "timeout" };

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DCR_TIMEOUT_MS;
  }
  return Math.min(Math.round(value), MAX_DCR_TIMEOUT_MS);
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

async function boundedFetch(
  fetchImpl: RailwayFetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<BoundedResponse> {
  const controller = new AbortController();
  const attempt = (async (): Promise<BoundedResponse> => {
    try {
      return {
        outcome: "response",
        response: await fetchImpl(input, { ...init, signal: controller.signal }),
      };
    } catch {
      return { outcome: "network-failure" };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedResponse>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedJson(response: Response, timeoutMs: number): Promise<BoundedJson> {
  const attempt = response.json()
    .then((value: unknown): BoundedJson => ({ outcome: "json", value }))
    .catch((): BoundedJson => ({ outcome: "invalid-json" }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedJson>((resolve) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      resolve({ outcome: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function managementUri(value: unknown, clientId: string): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://backboard.railway.com" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !url.pathname.startsWith("/oauth/register/") ||
    !url.pathname.endsWith(`/${encodeURIComponent(clientId)}`)
  ) {
    return undefined;
  }
  return url.toString();
}

function parseRegistration(value: unknown): RailwayDcrResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const clientId = record["client_id"];
  const token = record["registration_access_token"];
  if (
    typeof clientId !== "string" || clientId.length === 0 ||
    typeof token !== "string" || token.length === 0 ||
    record["client_secret"] !== undefined ||
    record["token_endpoint_auth_method"] !== "none" ||
    !exactStringArray(record["redirect_uris"], RAILWAY_DCR_REQUEST.redirect_uris) ||
    !exactStringArray(record["grant_types"], RAILWAY_DCR_REQUEST.grant_types) ||
    !exactStringArray(record["response_types"], RAILWAY_DCR_REQUEST.response_types)
  ) {
    return undefined;
  }
  if (record["application_type"] !== undefined && record["application_type"] !== "native") {
    return undefined;
  }
  const registrationClientUri = managementUri(record["registration_client_uri"], clientId);
  if (registrationClientUri === undefined) return undefined;
  return { clientId, registrationClientUri, registrationAccessToken: token };
}

async function httpFailure(response: Response, timeoutMs: number): Promise<RailwayDcrFailure> {
  const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
  if (response.status === 429) {
    return {
      kind: "rate-limited",
      httpStatus: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "initial-access-token-required", httpStatus: response.status };
  }
  if (response.status === 400) {
    const body = await boundedJson(response, timeoutMs);
    if (body.outcome === "timeout") return { kind: "request-timeout", httpStatus: 400 };
    const error = body.outcome === "json" &&
      typeof body.value === "object" && body.value !== null && !Array.isArray(body.value)
      ? (body.value as Record<string, unknown>)["error"]
      : undefined;
    if (error === "invalid_client") {
      return { kind: "invalid-client", httpStatus: response.status };
    }
    return { kind: "registration-rejected", httpStatus: response.status };
  }
  return { kind: "registration-rejected", httpStatus: response.status };
}

function managementCredentialCandidate(value: unknown): RailwayDcrManagementCredential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const clientId = record["client_id"];
  const token = record["registration_access_token"];
  if (typeof clientId !== "string" || clientId.length === 0 ||
      typeof token !== "string" || token.length === 0) {
    return undefined;
  }
  const registrationClientUri = managementUri(record["registration_client_uri"], clientId);
  return registrationClientUri === undefined ? undefined : {
    clientId,
    registrationClientUri,
    registrationAccessToken: token,
  };
}

async function deleteCredential(
  credential: RailwayDcrManagementCredential,
  fetchImpl: RailwayFetch,
  timeoutMs: number,
): Promise<RailwayDcrDeleteResult> {
  const result = await boundedFetch(fetchImpl, credential.registrationClientUri, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${credential.registrationAccessToken}`,
      accept: "application/json",
    },
  }, timeoutMs);
  if (result.outcome !== "response") {
    return {
      outcome: "failure",
      failure: { kind: result.outcome === "timeout" ? "request-timeout" : "network-failure" },
    };
  }
  if (result.response.status === 204) {
    return { outcome: "deleted", clientId: credential.clientId };
  }
  if (result.response.status === 401) {
    return { outcome: "failure", failure: { kind: "management-token-invalid", httpStatus: 401 } };
  }
  if (result.response.status === 403) {
    return { outcome: "failure", failure: { kind: "delete-forbidden", httpStatus: 403 } };
  }
  if (result.response.status === 405) {
    return { outcome: "failure", failure: { kind: "delete-unsupported", httpStatus: 405 } };
  }
  if (result.response.status === 429) {
    const retryAfterMs = retryAfterMilliseconds(result.response.headers.get("retry-after"));
    return {
      outcome: "failure",
      failure: {
        kind: "rate-limited",
        httpStatus: 429,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    };
  }
  return {
    outcome: "failure",
    failure: { kind: "cleanup-failed", httpStatus: result.response.status },
  };
}

/**
 * One anonymous RFC 7591 registration attempt. It intentionally sends no
 * Authorization header: requiring one means Railway has not removed the
 * upstream-account dependency that this spike is testing.
 */
export async function registerRailwayDynamicClient(
  options: RailwayDcrOptions,
): Promise<RailwayDcrRegistrationResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const result = await boundedFetch(fetchImpl, RAILWAY_DCR_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(RAILWAY_DCR_REQUEST),
  }, timeoutMs);
  if (result.outcome !== "response") {
    return {
      outcome: "failure",
      failure: { kind: result.outcome === "timeout" ? "request-timeout" : "network-failure" },
    };
  }
  if (!result.response.ok) {
    return { outcome: "failure", failure: await httpFailure(result.response, timeoutMs) };
  }

  const body = await boundedJson(result.response, timeoutMs);
  if (body.outcome !== "json") {
    if (body.outcome === "timeout") {
      return { outcome: "failure", failure: { kind: "request-timeout" } };
    }
    return { outcome: "failure", failure: { kind: "invalid-response" } };
  }
  const raw = body.value;
  const candidate = managementCredentialCandidate(raw);
  const registration = parseRegistration(raw);
  if (registration === undefined) {
    if (candidate !== undefined) {
      const cleanup = await deleteCredential(
        candidate,
        fetchImpl,
        timeoutMs,
      );
      if (cleanup.outcome !== "deleted") {
        return { outcome: "failure", failure: { kind: "cleanup-failed" } };
      }
    }
    return { outcome: "failure", failure: { kind: "invalid-response" } };
  }
  if (result.response.status !== 201) {
    const cleanup = await deleteCredential(
      candidate ?? registration,
      fetchImpl,
      timeoutMs,
    );
    return cleanup.outcome === "deleted"
      ? { outcome: "failure", failure: { kind: "invalid-response", httpStatus: result.response.status } }
      : { outcome: "failure", failure: { kind: "cleanup-failed", httpStatus: result.response.status } };
  }
  try {
    await options.authority.store({
      clientId: registration.clientId,
      registrationClientUri: registration.registrationClientUri,
      registrationAccessToken: registration.registrationAccessToken,
    });
  } catch {
    const cleanup = await deleteCredential(
      registration,
      fetchImpl,
      timeoutMs,
    );
    return cleanup.outcome === "deleted"
      ? { outcome: "failure", failure: { kind: "secure-authority-failed" } }
      : { outcome: "failure", failure: { kind: "cleanup-failed" } };
  }
  return {
    outcome: "registered",
    clientId: registration.clientId,
    initialAccessTokenUsed: false,
    appType: "native-public",
  };
}

export async function deleteRailwayDynamicClient(
  clientId: string,
  options: RailwayDcrOptions,
): Promise<RailwayDcrDeleteResult> {
  let credential: RailwayDcrManagementCredential | null;
  try {
    credential = await options.authority.load(clientId);
  } catch {
    return { outcome: "failure", failure: { kind: "secure-authority-failed" } };
  }
  if (credential === null || credential.clientId !== clientId) {
    return { outcome: "failure", failure: { kind: "management-token-invalid" } };
  }

  const result = await deleteCredential(
    credential,
    options.fetch ?? globalThis.fetch,
    boundedTimeout(options.timeoutMs),
  );
  if (result.outcome === "deleted") {
    try {
      await options.authority.clear(clientId);
    } catch {
      return { outcome: "failure", failure: { kind: "secure-authority-failed" } };
    }
    return result;
  }
  return result;
}
