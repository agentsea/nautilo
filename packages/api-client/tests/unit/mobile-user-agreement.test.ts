import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MOBILE_USER_AGREEMENT_VERSION, MOBILE_USER_AGREEMENT_VERSIONS } from "@nautilo/types";

import { NautiloApiClient } from "../../src/client";

describe("Mobile user agreement client contract", () => {
  let realFetch: typeof fetch;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    requests.length = 0;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({
        url: typeof input === "string" ? input : (input as URL).toString(),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null,
      });
      return new Response(JSON.stringify({
        current: MOBILE_USER_AGREEMENT_VERSIONS,
        accepted: false,
        acceptance: null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("uses one authenticated resource for read, acceptance, and withdrawal", async () => {
    const client = new NautiloApiClient("https://server.example");
    client.setToken("token");

    await client.getMobileUserAgreementState();
    await client.acceptMobileUserAgreement(MOBILE_USER_AGREEMENT_VERSION);
    await client.withdrawMobileUserAgreement();

    expect(requests).toEqual([
      { url: "https://server.example/api/mobile-user-agreement", method: "GET", body: null },
      {
        url: "https://server.example/api/mobile-user-agreement",
        method: "PUT",
        body: { agreementVersion: MOBILE_USER_AGREEMENT_VERSION },
      },
      { url: "https://server.example/api/mobile-user-agreement", method: "DELETE", body: null },
    ]);
  });
});
