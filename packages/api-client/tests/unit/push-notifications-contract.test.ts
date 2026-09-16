import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MobilePushInstallationApiError,
  NautiloApiClient,
} from "../../src/client";

const baseUrl = "https://nautilo.example.test";
const installationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const notificationId = "33333333-3333-4333-8333-333333333333";
const revokeProof = "r".repeat(48);
const updatedAt = "2026-08-05T20:00:00.000Z";

function status() {
  return {
    version: 1,
    installationId,
    bindingId,
    platform: "ios",
    enabled: true,
    tokenGeneration: 1,
    permission: "granted",
    state: "active",
    updatedAt,
  };
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") return null;
  return JSON.parse(init.body) as unknown;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("D468 push-installation client contract", () => {
  let realFetch: typeof fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    requests.length = 0;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = requestUrl(input);
        requests.push({ url, ...(init !== undefined ? { init } : {}) });
        if (url.endsWith("/test")) return Response.json({ accepted: true, notificationId });
        if (url.endsWith("/badge-preference")) {
          return Response.json({ version: 1, bindingId, tokenGeneration: 1, enabled: true });
        }
        if (url.endsWith("/revoke") || init?.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json(status());
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("uses exact versioned routes and never sends arbitrary notification copy", async () => {
    const client = new NautiloApiClient(baseUrl);
    client.setToken("fresh-token");
    await client.registerPushInstallation({
      version: 1,
      installationId,
      bindingId,
      platform: "ios",
      expoPushToken: "ExponentPushToken[opaque-token]",
      enabled: true,
      tokenGeneration: 1,
      appVersion: "0.1.0",
      permission: "granted",
      revokeProof,
    });
    await client.getPushInstallationStatus(bindingId);
    await client.setPushInstallationBadgePreference({
      version: 1,
      bindingId,
      tokenGeneration: 1,
      enabled: true,
    });
    await client.disablePushInstallation({
      version: 1,
      installationId,
      bindingId,
      enabled: false,
      tokenGeneration: 1,
      permission: "denied",
    });
    await client.sendPushInstallationTest(bindingId);
    await client.revokePushInstallation(bindingId);
    await client.revokePushInstallationWithProof({ version: 1, bindingId, revokeProof });

    expect(requests.map(({ url }) => url)).toEqual([
      `${baseUrl}/api/push/installations`,
      `${baseUrl}/api/push/installations/${bindingId}`,
      `${baseUrl}/api/push/installations/${bindingId}/badge-preference`,
      `${baseUrl}/api/push/installations/${bindingId}`,
      `${baseUrl}/api/push/installations/${bindingId}/test`,
      `${baseUrl}/api/push/installations/${bindingId}`,
      `${baseUrl}/api/push/installations/${bindingId}/revoke`,
    ]);
    expect(parseBody(requests[0]?.init)).toEqual({
      version: 1,
      installationId,
      bindingId,
      platform: "ios",
      expoPushToken: "ExponentPushToken[opaque-token]",
      enabled: true,
      tokenGeneration: 1,
      appVersion: "0.1.0",
      permission: "granted",
      revokeProof,
    });
    expect(parseBody(requests[2]?.init)).toEqual({
      version: 1,
      bindingId,
      tokenGeneration: 1,
      enabled: true,
    });
    expect(parseBody(requests[3]?.init)).toEqual({
      version: 1,
      installationId,
      bindingId,
      enabled: false,
      tokenGeneration: 1,
      permission: "denied",
    });
    expect(parseBody(requests[4]?.init)).toEqual({ version: 1 });
    expect(parseBody(requests[6]?.init)).toEqual({ version: 1, bindingId, revokeProof });
    expect(new Headers(requests[6]?.init?.headers).has("Authorization")).toBe(false);
  });

  test("parses only bounded status and test responses", async () => {
    const client = new NautiloApiClient(baseUrl);
    client.setToken("token");
    expect((await client.getPushInstallationStatus(bindingId)).state).toBe("active");
    expect((await client.sendPushInstallationTest(bindingId)).notificationId).toBe(notificationId);
  });

  test("preserves abort and exposes a structured unavailable error", async () => {
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return Response.json(
          { error: "Push is unavailable", code: "push_unavailable" },
          { status: 503 },
        );
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    const client = new NautiloApiClient(baseUrl);
    client.setToken("token");
    let caught: unknown;
    try {
      await client.getPushInstallationStatus(bindingId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MobilePushInstallationApiError);
    expect((caught as MobilePushInstallationApiError).code).toBe("push_unavailable");

    const controller = new AbortController();
    controller.abort();
    let abortError: unknown;
    try {
      await client.getPushInstallationStatus(bindingId, { signal: controller.signal });
    } catch (error) {
      abortError = error;
    }
    expect(abortError).toMatchObject({ name: "AbortError" });
  });
});
