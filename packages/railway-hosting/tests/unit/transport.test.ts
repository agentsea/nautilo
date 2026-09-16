import { describe, expect, test } from "bun:test";

import {
  RailwayGraphqlTransport,
  railwayMe,
  railwayVariableCollectionUpsert,
  type RailwayFetch,
} from "../../src/index";

function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("RailwayGraphqlTransport", () => {
  test("injects the caller abort signal into the exact GraphQL request", async () => {
    const controller = new AbortController(); let observed: AbortSignal | null | undefined;
    const transport = new RailwayGraphqlTransport({ accessToken: "request-token", fetch: async (_input, init) => {
      observed = init?.signal; return jsonResponse({ data: { me: { id: "user-1", name: null, workspaces: [] } } });
    } });
    await transport.execute(railwayMe, {}, { signal: controller.signal });
    expect(observed).toBe(controller.signal);
    controller.abort();
    expect(observed?.aborted).toBe(true);
  });

  test("posts the typed document and returns safe successful data with rate metadata", async () => {
    let capturedRequest: RequestInit | undefined;
    const requestToken = "not-a-real-oauth-token";
    const transport = new RailwayGraphqlTransport({
      accessToken: requestToken,
      fetch: async (_input, init): Promise<Response> => {
        capturedRequest = init;
        return jsonResponse(
          { data: { me: { id: "user-1", name: "Taylor", workspaces: [] } } },
          {
            headers: {
              "x-ratelimit-limit": "1000",
              "x-ratelimit-remaining": "999",
              "x-ratelimit-reset": "2030-01-01T00:00:00.000Z",
            },
          },
        );
      },
    });

    const result = await transport.execute(railwayMe, {});

    expect(result).toEqual({
      outcome: "success",
      data: { me: { id: "user-1", name: "Taylor", workspaces: [] } },
      metadata: {
        httpStatus: 200,
        rateLimit: {
          limit: 1000,
          remaining: 999,
          resetAt: "2030-01-01T00:00:00.000Z",
          retryAfterMs: undefined,
        },
      },
    });
    expect(capturedRequest?.headers).toEqual({
      authorization: `Bearer ${requestToken}`,
      "content-type": "application/json",
    });
  });

  test("treats GraphQL data plus errors as partial and redacts raw errors", async () => {
    const secretInServerError = "server-echoed-secret";
    const transport = new RailwayGraphqlTransport({
      accessToken: "not-a-real-oauth-token",
      fetch: async (): Promise<Response> =>
        jsonResponse({
          data: { me: { id: "user-1", name: "Taylor", workspaces: [] } },
          errors: [{ message: secretInServerError, extensions: { accessToken: secretInServerError } }],
        }),
    });

    const result = await transport.execute(railwayMe, {});

    expect(result.outcome).toBe("partial");
    expect(JSON.stringify(result)).not.toContain(secretInServerError);
    if (result.outcome === "partial") {
      expect(result.failure).toEqual({
        kind: "graphql-error",
        operation: "RailwayMe",
        httpStatus: 200,
        graphql: { kind: "graphql-error", count: 1 },
      });
    }
  });

  test.each([
    [null, "a JSON null envelope"],
    [{ errors: "not-an-array" }, "a malformed errors field"],
  ])("fails closed for %s", async (payload) => {
    const transport = new RailwayGraphqlTransport({
      accessToken: "not-a-real-oauth-token",
      fetch: async (): Promise<Response> => jsonResponse(payload),
    });

    const result = await transport.execute(railwayMe, {});
    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "invalid-response", operation: "RailwayMe", httpStatus: 200 },
      metadata: { httpStatus: 200, rateLimit: { retryAfterMs: undefined } },
    });
  });

  test.each([
    [401, "authentication-required"],
    [403, "permission-denied"],
  ] as const)("classifies HTTP %i without exposing a response body", async (status, kind) => {
    const transport = new RailwayGraphqlTransport({
      accessToken: "not-a-real-oauth-token",
      fetch: async (): Promise<Response> =>
        new Response("oauth-token=must-not-be-surfaced", { status }),
    });

    const result = await transport.execute(railwayMe, {});

    expect(result).toEqual({
      outcome: "failure",
      failure: { kind, operation: "RailwayMe", httpStatus: status },
      metadata: { httpStatus: status, rateLimit: { retryAfterMs: undefined } },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-surfaced");
  });

  test("reports rate limit metadata and retry timing without automatically retrying", async () => {
    const transport = new RailwayGraphqlTransport({
      accessToken: "not-a-real-oauth-token",
      fetch: async (): Promise<Response> =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "2", "x-ratelimit-remaining": "0" },
        }),
    });

    const result = await transport.execute(railwayMe, {});

    expect(result).toEqual({
      outcome: "failure",
      failure: {
        kind: "rate-limited",
        operation: "RailwayMe",
        httpStatus: 429,
        retryAfterMs: 2000,
      },
      metadata: {
        httpStatus: 429,
        rateLimit: { remaining: 0, retryAfterMs: 2000 },
      },
    });
  });

  test("does not surface OAuth tokens or variable maps in a network failure", async () => {
    const oauthToken = "never-surface-oauth-token";
    const providerSecret = "never-surface-provider-secret";
    const failingFetch: RailwayFetch = async (): Promise<Response> => {
      throw new Error(`transport failed with ${oauthToken} ${providerSecret}`);
    };
    const transport = new RailwayGraphqlTransport({ accessToken: oauthToken, fetch: failingFetch });

    const result = await transport.execute(railwayVariableCollectionUpsert, {
      input: {
        projectId: "project-1",
        environmentId: "environment-1",
        variables: { OPENROUTER_API_KEY: providerSecret },
        skipDeploys: true,
      },
    });

    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "network-failure", operation: "RailwayVariableCollectionUpsert" },
    });
    const surfaced = JSON.stringify(result);
    expect(surfaced).not.toContain(oauthToken);
    expect(surfaced).not.toContain(providerSecret);
    expect(surfaced).not.toContain("OPENROUTER_API_KEY");
  });
});
