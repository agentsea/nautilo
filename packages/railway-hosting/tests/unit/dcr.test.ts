import { describe, expect, test } from "bun:test";

import {
  deleteRailwayDynamicClient,
  registerRailwayDynamicClient,
  RAILWAY_DCR_ENDPOINT,
  RAILWAY_DCR_REQUEST,
  type RailwayDcrManagementCredential,
  type RailwayDcrSecureAuthority,
} from "../../src/dcr";
import { RAILWAY_OAUTH_REDIRECT_URI } from "../../src/oauth";

class MemoryAuthority implements RailwayDcrSecureAuthority {
  credential: RailwayDcrManagementCredential | null = null;
  failStore = false;
  clearCalls = 0;

  store(credential: RailwayDcrManagementCredential): Promise<void> {
    if (this.failStore) return Promise.reject(new Error("secure store unavailable"));
    this.credential = credential;
    return Promise.resolve();
  }

  load(clientId: string): Promise<RailwayDcrManagementCredential | null> {
    return Promise.resolve(this.credential?.clientId === clientId ? this.credential : null);
  }

  clear(clientId: string): Promise<void> {
    if (this.credential?.clientId === clientId) this.credential = null;
    this.clearCalls += 1;
    return Promise.resolve();
  }
}

function registrationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: "dynamic-client-id",
    client_name: RAILWAY_DCR_REQUEST.client_name,
    application_type: "native",
    redirect_uris: [...RAILWAY_DCR_REQUEST.redirect_uris],
    token_endpoint_auth_method: "none",
    grant_types: [...RAILWAY_DCR_REQUEST.grant_types],
    response_types: [...RAILWAY_DCR_REQUEST.response_types],
    registration_client_uri:
      "https://backboard.railway.com/oauth/register/dynamic-client-id",
    registration_access_token: "registration-management-secret",
    ...overrides,
  };
}

describe("Railway dynamic client registration", () => {
  test("registers an exact native public client without upstream authorization", async () => {
    const authority = new MemoryAuthority();
    let requestBody: unknown;
    const result = await registerRailwayDynamicClient({
      authority,
      fetch: async (input, init) => {
        expect(String(input)).toBe(RAILWAY_DCR_ENDPOINT);
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({
          accept: "application/json",
          "content-type": "application/json",
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (typeof init?.body !== "string") throw new Error("expected JSON request body");
        requestBody = JSON.parse(init.body) as unknown;
        return Response.json(registrationBody(), { status: 201 });
      },
    });

    expect(requestBody).toEqual({
      client_name: "Nautilo BYOC CLI",
      application_type: "native",
      redirect_uris: [RAILWAY_OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
    expect(result).toEqual({
      outcome: "registered",
      clientId: "dynamic-client-id",
      initialAccessTokenUsed: false,
      appType: "native-public",
    });
    expect(authority.credential).toEqual({
      clientId: "dynamic-client-id",
      registrationClientUri:
        "https://backboard.railway.com/oauth/register/dynamic-client-id",
      registrationAccessToken: "registration-management-secret",
    });
    expect(JSON.stringify(result)).not.toContain("registration-management-secret");
  });

  test.each([
    [429, { error: "too_many_requests", error_description: "provider detail" }, "rate-limited"],
    [401, { error: "invalid_token", error_description: "provider detail" }, "initial-access-token-required"],
    [403, { error: "forbidden", error_description: "provider detail" }, "initial-access-token-required"],
    [400, { error: "invalid_client", error_description: "provider detail" }, "invalid-client"],
  ] as const)("returns a redacted typed HTTP %s registration failure", async (status, body, kind) => {
    const authority = new MemoryAuthority();
    const result = await registerRailwayDynamicClient({
      authority,
      fetch: () => Promise.resolve(Response.json(body, {
        status,
        ...(status === 429 ? { headers: { "retry-after": "17" } } : {}),
      })),
    });
    expect(result).toMatchObject({
      outcome: "failure",
      failure: {
        kind,
        httpStatus: status,
        ...(status === 429 ? { retryAfterMs: 17_000 } : {}),
      },
    });
    expect(authority.credential).toBeNull();
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  test.each([
    { client_secret: "must-not-exist" },
    { token_endpoint_auth_method: "client_secret_basic" },
    { redirect_uris: ["http://127.0.0.1:1/callback"] },
    { registration_client_uri: "https://attacker.invalid/oauth/register/dynamic-client-id" },
  ])("rejects unsafe registration metadata and cleans up when possible", async (override) => {
    const authority = new MemoryAuthority();
    let deleteCalls = 0;
    const result = await registerRailwayDynamicClient({
      authority,
      fetch: (_input, init) => {
        if (init?.method === "DELETE") {
          deleteCalls += 1;
          expect(init.headers).toEqual({
            authorization: "Bearer registration-management-secret",
            accept: "application/json",
          });
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(Response.json(registrationBody(override), { status: 201 }));
      },
    });
    expect(result).toMatchObject({ outcome: "failure" });
    expect(authority.credential).toBeNull();
    expect(deleteCalls).toBe(
      !("registration_client_uri" in override) ? 1 : 0,
    );
    expect(JSON.stringify(result)).not.toContain("registration-management-secret");
  });

  test("cleans up immediately when the secure authority cannot retain management", async () => {
    const authority = new MemoryAuthority();
    authority.failStore = true;
    let deleteAuthorization = "";
    const result = await registerRailwayDynamicClient({
      authority,
      fetch: (_input, init) => {
        if (init?.method === "DELETE") {
          const headers = init.headers as Record<string, string>;
          deleteAuthorization = headers["authorization"] ?? "";
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(Response.json(registrationBody(), { status: 201 }));
      },
    });
    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "secure-authority-failed" },
    });
    expect(deleteAuthorization).toBe("Bearer registration-management-secret");
    expect(JSON.stringify(result)).not.toContain("registration-management-secret");
  });

  test("deletes only at the server-issued management URI and clears secure authority", async () => {
    const authority = new MemoryAuthority();
    await authority.store({
      clientId: "dynamic-client-id",
      registrationClientUri:
        "https://backboard.railway.com/oauth/register/dynamic-client-id",
      registrationAccessToken: "registration-management-secret",
    });
    const result = await deleteRailwayDynamicClient("dynamic-client-id", {
      authority,
      fetch: (input, init) => {
        expect(String(input)).toBe(
          "https://backboard.railway.com/oauth/register/dynamic-client-id",
        );
        expect(init?.method).toBe("DELETE");
        expect(init?.headers).toEqual({
          authorization: "Bearer registration-management-secret",
          accept: "application/json",
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    expect(result).toEqual({ outcome: "deleted", clientId: "dynamic-client-id" });
    expect(authority.credential).toBeNull();
    expect(authority.clearCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("registration-management-secret");
  });

  test("aborts registration on a bounded timeout without storing anything", async () => {
    const authority = new MemoryAuthority();
    let signal: AbortSignal | undefined;
    const result = await registerRailwayDynamicClient({
      authority,
      timeoutMs: 5,
      fetch: (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    expect(result).toEqual({ outcome: "failure", failure: { kind: "request-timeout" } });
    expect(signal?.aborted).toBe(true);
    expect(authority.credential).toBeNull();
  });

  test("bounds a registration response body that never completes", async () => {
    const authority = new MemoryAuthority();
    const result = await registerRailwayDynamicClient({
      authority,
      timeoutMs: 5,
      fetch: () => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })),
    });
    expect(result).toEqual({ outcome: "failure", failure: { kind: "request-timeout" } });
    expect(authority.credential).toBeNull();
  });
});
