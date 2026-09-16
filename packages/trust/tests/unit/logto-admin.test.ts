/**
 * M052 — `logto-admin.ts` unit tests.
 *
 * Covers:
 *   - Token caching + refresh.
 *   - `isUserActive` happy path / 404 / suspended / non-2xx.
 *   - `createUser`, `generatePasswordResetUrl`, `revokeUser` request shape.
 *   - **Boundary**: the class MUST NOT expose `assignOrganizationRole`,
 *     `listOrganizationMembers`, or any other org-role / org-membership
 *     method (per `research/logto-integration-v1.md` §4.8 — Logto is
 *     identity-only). This is locked in by an explicit
 *     `expect(...).toBeUndefined()` so a careless re-add fails CI.
 *   - Singleton helper validates required env vars.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  LogtoAdminClient,
  getLogtoAdminClient,
  _resetLogtoAdminClientForTests,
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

/**
 * Narrow the production-side `BodyInit` to a string for assertion.
 * The client always sends either `URLSearchParams` (form-encoded
 * token endpoint) or `JSON.stringify(...)` (Management API). Anything
 * else here is a test bug.
 */
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

function makeClient(): LogtoAdminClient {
  return new LogtoAdminClient(ENDPOINT, APP_ID, APP_SECRET);
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
  _resetLogtoAdminClientForTests();
});

// ---------------------------------------------------------------------------
// Token caching
// ---------------------------------------------------------------------------

describe("LogtoAdminClient.getAccessToken", () => {
  test("caches the access token across calls until near expiry", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok-1", expires_in: 3600 }),
    );
    const client = makeClient();
    const t1 = await client.getAccessToken();
    const t2 = await client.getAccessToken();
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-1");
    expect(fetchCalls.length).toBe(1);
  });

  test("issues client_credentials grant against /oidc/token with scope=all", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok-1", expires_in: 3600 }),
    );
    const client = makeClient();
    await client.getAccessToken("https://default.logto.app/api");

    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe(`${ENDPOINT}/oidc/token`);
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers?.["Authorization"]).toStartWith("Basic ");
    const body = bodyAsString(call.init);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("resource=https%3A%2F%2Fdefault.logto.app%2Fapi");
    expect(body).toContain("scope=all");
  });

  test("re-fetches once the cached token is near expiry", async () => {
    // First handshake — token expires in 30s, which is inside the 60s
    // safety window so the next call re-handshakes immediately.
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok-old", expires_in: 30 }),
    );
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok-new", expires_in: 3600 }),
    );
    const client = makeClient();
    expect(await client.getAccessToken()).toBe("tok-old");
    expect(await client.getAccessToken()).toBe("tok-new");
    expect(fetchCalls.length).toBe(2);
  });

  test("throws on non-2xx with the response body in the message", async () => {
    fetchQueue.push(() => textResponse("forbidden", 403));
    const client = makeClient();
    const err = await client.getAccessToken().catch((e: unknown) =>
      e instanceof Error ? e.message : String(e),
    );
    expect(err).toContain("403");
    expect(err).toContain("forbidden");
  });
});

// ---------------------------------------------------------------------------
// isUserActive
// ---------------------------------------------------------------------------

describe("LogtoAdminClient.isUserActive", () => {
  test("returns true on 200 + isSuspended:false", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({ id: "user-1", isSuspended: false }),
    );
    const client = makeClient();
    expect(await client.isUserActive("user-1")).toBe(true);
  });

  test("returns true when isSuspended is missing (defaults to active)", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "user-1" }));
    const client = makeClient();
    expect(await client.isUserActive("user-1")).toBe(true);
  });

  test("returns false on 200 + isSuspended:true", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({ id: "user-1", isSuspended: true }),
    );
    const client = makeClient();
    expect(await client.isUserActive("user-1")).toBe(false);
  });

  test("returns false on 404 (user removed)", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("not found", 404));
    const client = makeClient();
    expect(await client.isUserActive("ghost")).toBe(false);
  });

  test("throws on other non-2xx (revocation cache fails OPEN on this)", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("upstream timeout", 502));
    const client = makeClient();
    expect(client.isUserActive("user-1")).rejects.toThrow(/502/);
  });

  test("URL-encodes the sub", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "weird id", isSuspended: false }));
    const client = makeClient();
    await client.isUserActive("weird id");
    const userCall = fetchCalls[1]!;
    expect(userCall.url).toBe(`${ENDPOINT}/api/users/weird%20id`);
  });
});

// ---------------------------------------------------------------------------
// createUser / generatePasswordResetUrl / revokeUser
// ---------------------------------------------------------------------------

describe("LogtoAdminClient.createUser", () => {
  test("POSTs to /api/users with the documented body shape", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "new-user" }, 201));
    const client = makeClient();
    const out = await client.createUser({
      username: "alice_2",
      primaryEmail: "alice@example.com",
      name: "Alice",
    });
    expect(out.id).toBe("new-user");
    const call = fetchCalls[1]!;
    expect(call.url).toBe(`${ENDPOINT}/api/users`);
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer tok");
    expect(headers?.["Content-Type"]).toBe("application/json");
    const body = bodyAsJson(call.init);
    expect(body).toEqual({
      username: "alice_2",
      primaryEmail: "alice@example.com",
      name: "Alice",
    });
  });

  test("omits unset optional fields rather than sending nulls", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "new-user" }, 201));
    const client = makeClient();
    await client.createUser({ username: "bob_3" });
    const body = bodyAsJson(fetchCalls[1]!.init);
    expect(body).toEqual({ username: "bob_3" });
  });

  test("throws with the response body on failure", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("username taken", 422));
    const client = makeClient();
    expect(client.createUser({ username: "dup" })).rejects.toThrow(/422/);
  });
});

describe("LogtoAdminClient.createPersonalAccessToken (D112)", () => {
  test("POSTs /api/users/{id}/personal-access-tokens", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({ value: "pat_abc", name: "nautilo-claim-x" }, 201),
    );
    const client = makeClient();
    const out = await client.createPersonalAccessToken("user-1", {
      name: "nautilo-claim-x",
      expiresAt: 12345,
    });
    expect(out.value).toBe("pat_abc");
    const call = fetchCalls[1]!;
    expect(call.url).toBe(
      `${ENDPOINT}/api/users/user-1/personal-access-tokens`,
    );
    expect(bodyAsJson(call.init)).toEqual({
      name: "nautilo-claim-x",
      expiresAt: 12345,
    });
  });
});

describe("LogtoAdminClient.setUserPassword (M053)", () => {
  test("PATCHes /api/users/{id}/password with the new plaintext password", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "user-1" }));
    const client = makeClient();
    await client.setUserPassword("user-1", "temp-pw-123");
    const call = fetchCalls[1]!;
    expect(call.url).toBe(`${ENDPOINT}/api/users/user-1/password`);
    expect(call.init?.method).toBe("PATCH");
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer tok");
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(bodyAsJson(call.init)).toEqual({ password: "temp-pw-123" });
  });

  test("URL-encodes the sub", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "weird id" }));
    const client = makeClient();
    await client.setUserPassword("weird id", "pw");
    expect(fetchCalls[1]!.url).toBe(`${ENDPOINT}/api/users/weird%20id/password`);
  });

  test("throws on failure", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("policy violation", 422));
    const client = makeClient();
    expect(client.setUserPassword("user-1", "weak")).rejects.toThrow(/422/);
  });
});

describe("LogtoAdminClient.verifyUserPassword (D104)", () => {
  test("POSTs /api/users/{id}/password/verify with the plaintext password", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => new Response(null, { status: 204 }));
    const client = makeClient();
    expect(await client.verifyUserPassword("user-1", "current-pw")).toBe(true);
    const call = fetchCalls[1]!;
    expect(call.url).toBe(`${ENDPOINT}/api/users/user-1/password/verify`);
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer tok");
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(bodyAsJson(call.init)).toEqual({ password: "current-pw" });
  });

  test("returns false on 422 (password does not match)", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("no match", 422));
    const client = makeClient();
    expect(await client.verifyUserPassword("user-1", "wrong")).toBe(false);
  });

  test("URL-encodes the user id", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => new Response(null, { status: 204 }));
    const client = makeClient();
    await client.verifyUserPassword("weird id", "pw");
    expect(fetchCalls[1]!.url).toBe(
      `${ENDPOINT}/api/users/weird%20id/password/verify`,
    );
  });

  test("throws on unexpected status", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("oops", 500));
    const client = makeClient();
    expect(client.verifyUserPassword("user-1", "x")).rejects.toThrow(/500/);
  });
});

describe("LogtoAdminClient.getPasswordPolicy (D518)", () => {
  test("GETs the configured default-tenant password policy", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({
        passwordPolicy: {
          length: { min: 14, max: 200 },
          rejects: { pwned: false },
        },
      }),
    );

    const policy = await makeClient().getPasswordPolicy();

    expect(fetchCalls[1]?.url).toBe(`${ENDPOINT}/api/sign-in-exp`);
    expect(fetchCalls[1]?.init?.headers).toEqual({
      Authorization: "Bearer tok",
    });
    expect(policy).toEqual({
      length: { min: 14, max: 200 },
      rejects: { pwned: false },
    });
  });

  test("rejects malformed policy responses", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ passwordPolicy: null }));

    expect(makeClient().getPasswordPolicy()).rejects.toThrow(/invalid response/);
  });
});

describe("LogtoAdminClient.revokeUser", () => {
  test("PATCHes /api/users/{id}/is-suspended with isSuspended:true", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => new Response(null, { status: 204 }));
    const client = makeClient();
    await client.revokeUser("user-1");
    const call = fetchCalls[1]!;
    expect(call.url).toBe(`${ENDPOINT}/api/users/user-1/is-suspended`);
    expect(call.init?.method).toBe("PATCH");
    expect(bodyAsJson(call.init)).toEqual({
      isSuspended: true,
    });
  });

  test("throws on failure", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("conflict", 409));
    const client = makeClient();
    expect(client.revokeUser("user-1")).rejects.toThrow(/409/);
  });
});

// ---------------------------------------------------------------------------
// Boundary: NO authorization-bearing methods
// ---------------------------------------------------------------------------

describe("LogtoAdminClient surface — Logto is identity-only", () => {
  test("does NOT expose authorization-bearing methods", () => {
    const client = makeClient();
    // These are deliberately absent. If you find yourself wanting to
    // add one, the answer is: the Nautilo trust layer
    // (`@nautilo/trust` queries against `roles` / `groups` /
    // `group_members`) is where membership lives. See
    // `research/logto-integration-v1.md` §4.8 + the M052 issue's
    // Risks section for the boundary rule.
    type LogtoAdminClientShape = Record<string, unknown>;
    const c = client as unknown as LogtoAdminClientShape;
    expect(c["assignOrganizationRole"]).toBeUndefined();
    expect(c["listOrganizationMembers"]).toBeUndefined();
    expect(c["addOrganizationMember"]).toBeUndefined();
    expect(c["removeOrganizationMember"]).toBeUndefined();
    expect(c["createOrganizationRole"]).toBeUndefined();
    expect(c["assignRoleToUser"]).toBeUndefined();
    expect(c["assignUserRole"]).toBeUndefined();
  });

  test("auth-pure methods that ARE present have the expected names", () => {
    const client = makeClient();
    expect(typeof client.getAccessToken).toBe("function");
    expect(typeof client.isUserActive).toBe("function");
    expect(typeof client.createUser).toBe("function");
    expect(typeof client.createPersonalAccessToken).toBe("function");
    expect(typeof client.setUserPassword).toBe("function");
    expect(typeof client.verifyUserPassword).toBe("function");
    expect(typeof client.getPasswordPolicy).toBe("function");
    expect(typeof client.revokeUser).toBe("function");
    // M053 additions — also auth-pure (account lookup + lifecycle + read).
    expect(typeof client.deleteUser).toBe("function");
    expect(typeof client.findUserByEmailOrUsername).toBe("function");
    expect(typeof client.getUser).toBe("function");
    expect(typeof client.patchUser).toBe("function");
    // M105 addition — auth-pure (mints email-bound one-time-token; no role assignment).
    expect(typeof client.createOneTimeToken).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// M053 — deleteUser / findUserByEmailOrUsername / getUser
// ---------------------------------------------------------------------------

describe("LogtoAdminClient.deleteUser", () => {
  test("DELETEs /api/users/{id} with the bearer token", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => new Response(null, { status: 204 }));
    const client = makeClient();
    await client.deleteUser("user-1");
    const call = fetchCalls[1]!;
    expect(call.url).toBe(`${ENDPOINT}/api/users/user-1`);
    expect(call.init?.method).toBe("DELETE");
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer tok");
  });

  test("treats 404 as success (idempotent retry)", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("not found", 404));
    const client = makeClient();
    await client.deleteUser("ghost");
  });

  test("throws on other non-2xx", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("forbidden", 403));
    const client = makeClient();
    expect(client.deleteUser("user-1")).rejects.toThrow(/403/);
  });

  test("URL-encodes the sub", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => new Response(null, { status: 204 }));
    const client = makeClient();
    await client.deleteUser("weird id");
    expect(fetchCalls[1]!.url).toBe(`${ENDPOINT}/api/users/weird%20id`);
  });
});

describe("LogtoAdminClient.findUserByEmailOrUsername", () => {
  test("searches by primaryEmail first, returns exact match", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse([
        {
          id: "user-1",
          isSuspended: false,
          primaryEmail: "alice@example.com",
          username: "alice",
        },
      ]),
    );
    const client = makeClient();
    const hit = await client.findUserByEmailOrUsername(
      "alice@example.com",
      "alice",
    );
    expect(hit).toEqual({
      id: "user-1",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
    const call = fetchCalls[1]!;
    expect(call.url).toContain("/api/users?");
    expect(call.url).toContain("search=alice%40example.com");
    // No `searchFields[]` parameter — Logto rejects that combination
    // with 400 unless `mode=exact` is also set; we filter client-side.
    expect(call.url).not.toContain("searchFields");
  });

  test("falls back to username search when email yields no exact match", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    // Email search returns a fuzzy hit that doesn't exact-match.
    fetchQueue.push(() =>
      jsonResponse([
        {
          id: "user-other",
          primaryEmail: "alice2@example.com",
          username: "alice2",
        },
      ]),
    );
    fetchQueue.push(() =>
      jsonResponse([
        {
          id: "user-1",
          isSuspended: true,
          primaryEmail: "alice@example.com",
          username: "alice",
        },
      ]),
    );
    const client = makeClient();
    const hit = await client.findUserByEmailOrUsername(
      "alice@example.com",
      "alice",
    );
    expect(hit?.id).toBe("user-1");
    expect(hit?.isSuspended).toBe(true);
    // Two list-users requests issued (email then username).
    expect(fetchCalls.length).toBe(3);
    expect(fetchCalls[2]!.url).toContain("search=alice");
    expect(fetchCalls[2]!.url).not.toContain("searchFields");
  });

  test("returns null when neither search produces an exact hit", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse([]));
    fetchQueue.push(() => jsonResponse([]));
    const client = makeClient();
    expect(
      await client.findUserByEmailOrUsername("nobody@example.com", "nobody"),
    ).toBeNull();
  });

  test("skips email search when email is empty", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse([
        {
          id: "user-1",
          primaryEmail: null,
          username: "alice",
        },
      ]),
    );
    const client = makeClient();
    const hit = await client.findUserByEmailOrUsername("", "alice");
    expect(hit?.id).toBe("user-1");
    // Only one list call (the username one) — email branch was skipped.
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1]!.url).toContain("search=alice");
  });

  test("returns null when both inputs are empty/null", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    const client = makeClient();
    expect(await client.findUserByEmailOrUsername(null, null)).toBeNull();
    // No /api/users call issued, but token was NOT minted either since
    // both branches early-returned. Tolerate either fetchCalls length 0
    // or 1 (token mint) for robustness against future eager-prefetch.
    expect(fetchCalls.length).toBeLessThanOrEqual(1);
  });

  test("throws on non-2xx from the search endpoint", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("boom", 500));
    const client = makeClient();
    expect(
      client.findUserByEmailOrUsername("alice@example.com", "alice"),
    ).rejects.toThrow(/500/);
  });
});

describe("LogtoAdminClient.getUser", () => {
  test("returns the parsed details on 200", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() =>
      jsonResponse({
        id: "user-1",
        isSuspended: false,
        primaryEmail: "alice@example.com",
        username: "alice",
      }),
    );
    const client = makeClient();
    const out = await client.getUser("user-1");
    expect(out).toEqual({
      id: "user-1",
      isSuspended: false,
      primaryEmail: "alice@example.com",
      username: "alice",
    });
  });

  test("returns null on 404", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("not found", 404));
    const client = makeClient();
    expect(await client.getUser("ghost")).toBeNull();
  });

  test("normalizes missing optional fields to null/false", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "user-1" }));
    const client = makeClient();
    const out = await client.getUser("user-1");
    expect(out).toEqual({
      id: "user-1",
      isSuspended: false,
      primaryEmail: null,
      username: null,
    });
  });

  test("throws on other non-2xx", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("boom", 500));
    const client = makeClient();
    expect(client.getUser("user-1")).rejects.toThrow(/500/);
  });
});

describe("LogtoAdminClient.patchUser", () => {
  test("PATCHes /api/users/{id} and returns the HTTP status", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => jsonResponse({ id: "user-1", username: "bob" }, 200));
    const client = makeClient();
    const status = await client.patchUser("user-1", { username: "bob" });
    expect(status).toBe(200);
    const call = fetchCalls[1]!;
    expect(call.url).toBe(`${ENDPOINT}/api/users/user-1`);
    expect(call.init?.method).toBe("PATCH");
    const body = JSON.parse((call.init?.body as string) ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ username: "bob" });
  });

  test("returns 409 without throwing so callers can branch", async () => {
    fetchQueue.push(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    fetchQueue.push(() => textResponse("conflict", 409));
    const client = makeClient();
    const status = await client.patchUser("user-1", { username: "taken" });
    expect(status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Singleton helper
// ---------------------------------------------------------------------------

describe("getLogtoAdminClient", () => {
  test("throws when LOGTO_* env vars are missing", () => {
    delete process.env["LOGTO_ENDPOINT"];
    delete process.env["LOGTO_M2M_APP_ID"];
    delete process.env["LOGTO_M2M_APP_SECRET"];
    expect(() => getLogtoAdminClient()).toThrow(
      /LOGTO_ENDPOINT \/ LOGTO_M2M_APP_ID \/ LOGTO_M2M_APP_SECRET/,
    );
  });

  test("constructs and caches the singleton when env vars are set", () => {
    process.env["LOGTO_ENDPOINT"] = ENDPOINT;
    process.env["LOGTO_M2M_APP_ID"] = APP_ID;
    process.env["LOGTO_M2M_APP_SECRET"] = APP_SECRET;
    try {
      const a = getLogtoAdminClient();
      const b = getLogtoAdminClient();
      expect(a).toBe(b);
    } finally {
      delete process.env["LOGTO_ENDPOINT"];
      delete process.env["LOGTO_M2M_APP_ID"];
      delete process.env["LOGTO_M2M_APP_SECRET"];
    }
  });
});
