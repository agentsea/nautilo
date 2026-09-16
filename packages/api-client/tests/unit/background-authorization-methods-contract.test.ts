import { describe, expect, test } from "bun:test";

import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";
import {
  BACKGROUND_AUTHORIZATION_MAX_LIST_REQUESTS,
  BACKGROUND_AUTHORIZATION_MAX_REQUEST_CHARACTERS,
  BACKGROUND_AUTHORIZATION_MAX_RESPONSE_CHARACTERS,
  backgroundAuthorizationListResponseSchema,
  backgroundAuthorizationRespondRequestSchema,
  backgroundAuthorizationRespondResponseSchema,
} from "../../src/schemas/background-authorization";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("background authorization HTTP methods", () => {
  test("uses current-session transport and preserves opaque carriers", async () => {
    const requests: Array<Readonly<{
      path: string;
      authorization: string | null;
      body: unknown;
      signal: AbortSignal | null | undefined;
    }>> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = new URL(typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url);
      requests.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        signal: init?.signal,
      });
      return url.pathname.endsWith("/list")
        ? json({
          responseVersion: 1,
          requests: [{ requestBytesBase64url: "AAEC_f7_" }],
          continuation: "bmV4dA",
        })
        : json({ responseVersion: 1, status: "accepted" });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("session-token");
    const controller = new AbortController();

    const listed = await client.listBackgroundAuthorizationRequests(
      { continuation: "cHJldmlvdXM" },
      { signal: controller.signal },
    );
    const responded = await client.respondBackgroundAuthorizationRequest(
      { responseBytesBase64url: "AAEC_f7_" },
      { signal: controller.signal },
    );

    expect(listed.requests[0]?.requestBytesBase64url).toBe("AAEC_f7_");
    expect(listed.continuation).toBe("bmV4dA");
    expect(responded.status).toBe("accepted");
    expect(requests).toEqual([
      {
        path: "/api/background-authorization/requests/list",
        authorization: "Bearer session-token",
        body: { requestVersion: 1, continuation: "cHJldmlvdXM" },
        signal: controller.signal,
      },
      {
        path: "/api/background-authorization/respond",
        authorization: "Bearer session-token",
        body: { requestVersion: 1, responseBytesBase64url: "AAEC_f7_" },
        signal: controller.signal,
      },
    ]);
  });

  test("rejects identity selectors and noncanonical carriers before fetch", async () => {
    let calls = 0;
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => {
        calls += 1;
        return json({ responseVersion: 1, requests: [] });
      },
    });
    client.setToken("session-token");

    expect(client.listBackgroundAuthorizationRequests({
      continuation: "AQ==",
    })).rejects.toThrow();
    expect(client.listBackgroundAuthorizationRequests({
      deviceId: "spoofed",
    } as never)).rejects.toThrow();
    expect(client.respondBackgroundAuthorizationRequest({
      responseBytesBase64url: "A",
    })).rejects.toThrow();
    expect(client.respondBackgroundAuthorizationRequest({
      responseBytesBase64url: "AQ",
      humanActorId: "spoofed",
    } as never)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("strictly validates list and every acknowledgement", () => {
    expect(backgroundAuthorizationListResponseSchema.safeParse({
      responseVersion: 1,
      requests: [{ requestBytesBase64url: "AQ" }],
      deviceId: "leak",
    }).success).toBeFalse();
    for (const status of [
      "accepted",
      "duplicate",
      "stale",
      "unauthorized",
      "superseded",
      "malformed",
    ]) {
      expect(backgroundAuthorizationRespondResponseSchema.safeParse({
        responseVersion: 1,
        status,
      }).success).toBeTrue();
    }
    expect(backgroundAuthorizationRespondResponseSchema.safeParse({
      responseVersion: 1,
      status: "unknown",
    }).success).toBeFalse();
  });

  test("bounds the generic V2 carriers and aggregate discovery page", () => {
    const maximumRequest = "A".repeat(
      BACKGROUND_AUTHORIZATION_MAX_REQUEST_CHARACTERS,
    );
    const maximumResponse = "A".repeat(
      BACKGROUND_AUTHORIZATION_MAX_RESPONSE_CHARACTERS,
    );
    expect(backgroundAuthorizationListResponseSchema.safeParse({
      responseVersion: 1,
      requests: [{ requestBytesBase64url: maximumRequest }],
    }).success).toBeTrue();
    expect(backgroundAuthorizationRespondRequestSchema.safeParse({
      requestVersion: 1,
      responseBytesBase64url: maximumResponse,
    }).success).toBeTrue();
    expect(backgroundAuthorizationRespondRequestSchema.safeParse({
      requestVersion: 1,
      responseBytesBase64url: `${maximumResponse}A`,
    }).success).toBeFalse();

    const oneByteRequest = { requestBytesBase64url: "AA" };
    expect(backgroundAuthorizationListResponseSchema.safeParse({
      responseVersion: 1,
      requests: Array.from(
        { length: BACKGROUND_AUTHORIZATION_MAX_LIST_REQUESTS + 1 },
        () => oneByteRequest,
      ),
    }).success).toBeFalse();
    expect(backgroundAuthorizationListResponseSchema.safeParse({
      responseVersion: 1,
      requests: [
        { requestBytesBase64url: maximumRequest },
        oneByteRequest,
      ],
    }).success).toBeFalse();
  });
});
