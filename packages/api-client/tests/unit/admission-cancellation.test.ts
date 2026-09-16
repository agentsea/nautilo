import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ApiError, NautiloApiClient } from "../../src/client";

const challenge = {
  formatVersion: 1 as const,
  challengeId: "challenge-1",
  credentialDigestBase64url: "AQ",
  userId: "11111111-1111-4111-8111-111111111111",
  humanActorId: "22222222-2222-4222-8222-222222222222",
  deviceId: "browser-device",
  deviceGeneration: 1,
  serverInstanceId: "33333333-3333-4333-8333-333333333333",
  lineageGeneration: 1,
  epoch: 1,
  securityRevision: 1,
  headDigestBase64url: "Ag",
  nonceBase64url: "Aw",
  issuedAt: 1,
  expiresAt: 2,
};

describe("admission reconciliation cancellation", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test.each([null, "stale-token"])("policy starts admission with a freshly acquired bearer from %s", async cached => {
    const seen: Array<string | null> = [];
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization"));
      return Response.json(seen.length === 1 ? {
        responseVersion: 1, requiresCryptoDevice: true, canManage: true,
        policy: {mode: "shadow_encryption", shadowBehavior: "fallback", revision: 1, updatedAt: "2026-09-10T12:00:00.000Z"},
        coveragePreview: {protected: "0", unsupported: "0", unexercised: "0"},
      } : {responseVersion: 1, required: true, status: "required", reason: "device_admission_required"});
    }, {preconnect: realFetch.preconnect.bind(realFetch)}) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken(cached);
    let acquisitions = 0;
    client.setTokenProvider(() => {acquisitions++; return Promise.resolve("fresh-token");});
    await client.admin.encryptionTransition.getPolicy();
    await client.deviceAdmission.status();
    expect(seen).toEqual(["Bearer fresh-token", "Bearer fresh-token"]);
    expect(client.getToken()).toBe("fresh-token");
    expect(acquisitions).toBe(1);
  });

  test("forwards and observes AbortSignal for every policy/admission request", async () => {
    const seen: Array<{
      url: string;
      method: string;
      signal: AbortSignal | null | undefined;
    }> = [];
    let started: (() => void) | undefined;
    globalThis.fetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const signal = init?.signal;
      seen.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        method: init?.method ?? "GET",
        signal,
      });
      started?.();
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () => reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("The operation was aborted.", "AbortError"),
        );
        if (signal?.aborted) {
          rejectAborted();
          return;
        }
        signal?.addEventListener("abort", rejectAborted, { once: true });
      });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token");
    const requests = [
      (signal: AbortSignal) => client.admin.encryptionTransition.getPolicy({ signal }),
      (signal: AbortSignal) => client.deviceAdmission.status({ signal }),
      (signal: AbortSignal) => client.deviceAdmission.challenge(
        { requestVersion: 1, deviceId: challenge.deviceId },
        { signal },
      ),
      (signal: AbortSignal) => client.deviceAdmission.prove(
        {
          requestVersion: 1,
          proof: { ...challenge, signatureBase64url: "BA" },
        },
        { signal },
      ),
    ] as const;

    for (const request of requests) {
      const controller = new AbortController();
      const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
      const pending = request(controller.signal);
      await fetchStarted;
      expect(seen.at(-1)?.signal).toBe(controller.signal);
      controller.abort();
      let caught: unknown;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ name: "AbortError" });
    }

    expect(seen.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "http://127.0.0.1:9/api/encryption-transition/policy", method: "GET" },
      { url: "http://127.0.0.1:9/api/crypto-device-admission/status", method: "GET" },
      { url: "http://127.0.0.1:9/api/crypto-device-admission/challenge", method: "POST" },
      { url: "http://127.0.0.1:9/api/crypto-device-admission/proof", method: "POST" },
    ]);
  });
});

describe("admission reconciliation retry metadata", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  function respondWithError(status: number, retryAfter: string): void {
    globalThis.fetch = Object.assign(async () => new Response(
      JSON.stringify({ error: "temporarily_unavailable" }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": retryAfter,
        },
      },
    ), { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
  }

  test("preserves numeric Retry-After on a policy error", async () => {
    respondWithError(429, "2.5");
    const client = new NautiloApiClient("http://127.0.0.1:9");

    const error: unknown = await client.admin.encryptionTransition.getPolicy().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      status: 429,
      retryAfterMs: 2_500,
    } satisfies Partial<ApiError>);
  });

  test("preserves HTTP-date Retry-After on an admission status error", async () => {
    const realDateNow = Date.now;
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    Date.now = () => now;
    try {
      respondWithError(503, "Tue, 01 Jan 2030 00:00:07 GMT");
      const client = new NautiloApiClient("http://127.0.0.1:9");

      const error: unknown = await client.deviceAdmission.status().catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        status: 503,
        retryAfterMs: 7_000,
      } satisfies Partial<ApiError>);
    } finally {
      Date.now = realDateNow;
    }
  });

  test.each(["not-a-delay", "", "-1", "1e309"])("ignores invalid Retry-After %s", async (header) => {
    respondWithError(503, header);
    const client = new NautiloApiClient("http://127.0.0.1:9");

    const error: unknown = await client.deviceAdmission.status().catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      status: 503,
      retryAfterMs: undefined,
    } satisfies Partial<ApiError>);
  });
});
