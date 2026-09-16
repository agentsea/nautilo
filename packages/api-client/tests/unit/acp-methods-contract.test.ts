import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

describe("ACP harness HTTP contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("lists only strictly validated product descriptors", async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      harnesses: [{
        id: "hermes-acp",
        displayName: "Hermes",
        setup: { installation: "manual", activation: "user_initiated" },
        integration: { authentication: "existing_session", resume: "new_session_only" },
        declaredCapabilities: {
          execution: "supported",
          resume: "unsupported",
          stop: "unsupported",
          steer: "unsupported",
          requests: "unsupported",
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const result = await new NautiloApiClient("http://127.0.0.1:9").acp.harnesses();
    expect(result.harnesses[0]?.id).toBe("hermes-acp");
    expect(result.harnesses[0]?.declaredCapabilities.stop).toBe("unsupported");
  });

  test("sends exact host selection in the readiness body and rejects extra peer fields", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      seenBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({
        state: "ready",
        action: null,
        executablePath: "/private/runtime",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let rejected = false;
    try {
      await client.acp.readiness("hermes-acp", "relay-current");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(seenUrl).toBe("http://127.0.0.1:9/api/acp/harnesses/hermes-acp/readiness");
    expect(seenBody).toEqual({ relayId: "relay-current" });
  });
});
