import { afterEach, describe, expect, test } from "bun:test";

import {
  AgentPhotoLibraryApiError,
  ApiError,
  NautiloApiClient,
  type UnauthorizedResponse,
} from "../../src/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe("NautiloApiClient unauthorized response handler", () => {
  test("observes a typed device-admission rejection without hiding the API error", async () => {
    globalThis.fetch = (async () => Response.json({
      code: "device_admission_expired",
      error: "Precondition Required",
    }, { status: 428 })) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    client.setToken("current-token");
    const observed: string[] = [];
    client.setDeviceAdmissionRequiredHandler((code) => { observed.push(code); });

    expect(await captureError(client.getModels())).toEqual(
      new ApiError(428, "Precondition Required"),
    );
    expect(observed).toEqual(["device_admission_expired"]);
  });

  test("observes fail-closed admission unavailability", async () => {
    globalThis.fetch = (async () => Response.json({
      code: "device_admission_unavailable",
      error: "Service Unavailable",
    }, { status: 503 })) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    client.setToken("current-token");
    const observed: string[] = [];
    client.setDeviceAdmissionRequiredHandler((code) => { observed.push(code); });

    expect(await captureError(client.getModels())).toEqual(
      new ApiError(503, "Service Unavailable"),
    );
    expect(observed).toEqual(["device_admission_unavailable"]);
  });

  test("observes an authenticated 401 from the common request path without replacing its error", async () => {
    globalThis.fetch = (async () => Response.json({ error: "Authentication required" }, { status: 401 })) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    client.setToken("dead-token");
    const observed: UnauthorizedResponse[] = [];
    client.setUnauthorizedResponseHandler((response) => { observed.push(response); });

    expect(await captureError(client.getModels())).toEqual(new ApiError(401, "Authentication required"));
    expect(observed).toEqual([{
      url: "https://nautilo.test/api/config/models",
      method: "GET",
      error: "Authentication required",
      retryAttempted: false,
    }]);
  });

  test("covers residual direct fetch paths through the same shim", async () => {
    globalThis.fetch = (async () => Response.json({
      error: {
        code: "authentication_required",
        message: "Unauthorized",
        retryable: false,
      },
    }, { status: 401 })) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    client.setTokenProvider(async () => "dead-token");
    const observed: UnauthorizedResponse[] = [];
    client.setUnauthorizedResponseHandler((response) => { observed.push(response); });

    expect(await captureError(client.uploadAgentPhotoLibraryEntry(
      new Blob(["x"], { type: "image/png" }),
      {
        idempotencyKey: "60000000-0000-4000-8000-000000000006",
        origin: "mobile",
      },
    ))).toEqual(new AgentPhotoLibraryApiError({
      status: 401,
      code: "authentication_required",
      message: "Unauthorized",
      retryable: false,
    }));
    expect(observed).toEqual([{
      url: "https://nautilo.test/api/profile/agent-photo-library/upload",
      method: "POST",
      error: null,
      retryAttempted: false,
    }]);
  });

  test("does not notify for unauthenticated, forbidden, or successful responses", async () => {
    let response = Response.json({ error: "Authentication required" }, { status: 401 });
    globalThis.fetch = (async () => response) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    const observed: UnauthorizedResponse[] = [];
    client.setUnauthorizedResponseHandler((value) => { observed.push(value); });
    expect(await captureError(client.getModels())).toBeInstanceOf(ApiError);

    client.setToken("token");
    response = Response.json({ error: "Forbidden" }, { status: 403 });
    expect(await captureError(client.getModels())).toBeInstanceOf(ApiError);
    response = Response.json([]);
    expect(await client.getModels()).toEqual([]);
    expect(observed).toEqual([]);
  });

  test("replays once with a replacement session bearer and reports a rejected replay", async () => {
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    client.setToken("dead-token");
    const observed: UnauthorizedResponse[] = [];
    client.setUnauthorizedResponseHandler((response) => {
      observed.push(response);
      return response.retryAttempted ? null : "refreshed-token";
    });

    expect(await captureError(client.getModels())).toEqual(new ApiError(401, "invalid_token"));
    expect(authorizations).toEqual(["Bearer dead-token", "Bearer refreshed-token"]);
    expect(observed.map((entry) => entry.retryAttempted)).toEqual([false, true]);
  });

  test("parallel stale responses reuse one request's refreshed bearer", async () => {
    let releaseSecond!: () => void;
    const secondMayReturn = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let oldTokenCalls = 0;
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      authorizations.push(authorization);
      if (authorization === "Bearer refreshed-token") return Response.json([]);
      oldTokenCalls += 1;
      if (oldTokenCalls === 2) await secondMayReturn;
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    client.setToken("dead-token");
    let refreshes = 0;
    client.setUnauthorizedResponseHandler(() => {
      refreshes += 1;
      releaseSecond();
      return "refreshed-token";
    });

    const [first, second] = await Promise.all([
      client.getModels(),
      client.getModels({ includeUnavailable: true }),
    ]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual([
      "Bearer dead-token",
      "Bearer dead-token",
      "Bearer refreshed-token",
      "Bearer refreshed-token",
    ]);
  });

  test("sign-out during recovery prevents token resurrection and replay", async () => {
    const authorizations: Array<string | null> = [];
    let releaseRecovery!: () => void;
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    const recovery = new Promise<string>((resolve) => {
      releaseRecovery = () => resolve("refreshed-token");
    });
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient("https://nautilo.test");
    client.setToken("dead-token");
    client.setUnauthorizedResponseHandler(() => {
      recoveryStarted();
      return recovery;
    });

    const request = captureError(client.getModels());
    await started;
    client.setToken(null);
    releaseRecovery();

    expect(await request).toEqual(new ApiError(401, "invalid_token"));
    expect(authorizations).toEqual(["Bearer dead-token"]);
  });
});
