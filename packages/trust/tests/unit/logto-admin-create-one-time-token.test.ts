/**
 * M105 — `LogtoAdminClient.createOneTimeToken` unit tests.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  LogtoAdminClient,
  LogtoOneTimeTokenError,
} from "../../src/logto-admin";

const ENDPOINT = "http://localhost:3301";
const APP_ID = "m2m-test";
const APP_SECRET = "m2m-secret";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];
let fetchQueue: Array<() => Response | Promise<Response>> = [];
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function bodyAsString(init: RequestInit | undefined): string {
  const body = init?.body;
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error(
    `bodyAsString: unexpected body type ${Object.prototype.toString.call(body)}`,
  );
}

function bodyAsJson(
  init: RequestInit | undefined,
): Record<string, unknown> {
  return JSON.parse(bodyAsString(init)) as Record<string, unknown>;
}

function nextResponse(): Response | Promise<Response> {
  const handler = fetchQueue.shift();
  if (!handler) {
    throw new Error("Test bug: fetch called more times than queued responses");
  }
  return handler();
}

beforeEach(() => {
  fetchCalls = [];
  fetchQueue = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return nextResponse();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LogtoAdminClient.createOneTimeToken (M105)", () => {
  test("POSTs to /api/one-time-tokens with the documented body shape", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({
        id: "ot-1",
        token: "ot_secret",
        expiresAt: "2026-05-15T12:00:00.000Z",
        email: "alice@example.com",
      }),
    );
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const out = await client.createOneTimeToken({
      email: "alice@example.com",
    });
    const call = fetchCalls[1]!;
    expect(call.url).toBe(`${ENDPOINT}/api/one-time-tokens`);
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer tok");
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(bodyAsJson(call.init)).toEqual({
      email: "alice@example.com",
      expiresIn: 600,
    });
    expect(out.id).toBe("ot-1");
    expect(out.token).toBe("ot_secret");
    expect(out.email).toBe("alice@example.com");
    expect(out.expiresAt).toEqual(
      new Date(Date.parse("2026-05-15T12:00:00.000Z")),
    );
  });

  test("includes context when provided", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({
        id: "ot-1",
        token: "ot_secret",
        expiresAt: "2026-05-15T12:00:00.000Z",
        email: "alice@example.com",
      }),
    );
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    await client.createOneTimeToken({
      email: "alice@example.com",
      context: { nautiloInviteToken: "inv_abc" },
    });
    expect(bodyAsJson(fetchCalls[1]!.init)).toEqual({
      email: "alice@example.com",
      expiresIn: 600,
      context: { nautiloInviteToken: "inv_abc" },
    });
  });

  test("accepts numeric expiresAt epoch-ms in response", async () => {
    const epochMs = 1_718_280_000_000;
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({
        id: "ot-1",
        token: "ot_secret",
        expiresAt: epochMs,
        email: "alice@example.com",
      }),
    );
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const out = await client.createOneTimeToken({
      email: "alice@example.com",
    });
    expect(out.expiresAt).toEqual(new Date(epochMs));
  });

  test("throws RangeError synchronously when expiresIn > 86400", async () => {
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const p = client.createOneTimeToken({ email: "x@y", expiresIn: 999_999 });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(fetchCalls.length).toBe(0);
  });

  test("maps 404 to LogtoOneTimeTokenError code endpoint-missing", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("not found", 404));
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const p = client.createOneTimeToken({ email: "alice@example.com" });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogtoOneTimeTokenError);
    expect((err as LogtoOneTimeTokenError).code).toBe("endpoint-missing");
  });

  test("maps 401 to code m2m-auth-failed", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("unauthorized", 401));
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const p = client.createOneTimeToken({ email: "alice@example.com" });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogtoOneTimeTokenError);
    expect((err as LogtoOneTimeTokenError).code).toBe("m2m-auth-failed");
  });

  test("maps 422 to code bad-email", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("invalid email", 422));
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const p = client.createOneTimeToken({ email: "alice@example.com" });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogtoOneTimeTokenError);
    expect((err as LogtoOneTimeTokenError).code).toBe("bad-email");
  });

  test("maps 429 to code rate-limited", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("too many", 429));
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const p = client.createOneTimeToken({ email: "alice@example.com" });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogtoOneTimeTokenError);
    expect((err as LogtoOneTimeTokenError).code).toBe("rate-limited");
  });

  test("maps 500 to code unknown", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("boom", 500));
    const client = new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
    const p = client.createOneTimeToken({ email: "alice@example.com" });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogtoOneTimeTokenError);
    expect((err as LogtoOneTimeTokenError).code).toBe("unknown");
  });
});
