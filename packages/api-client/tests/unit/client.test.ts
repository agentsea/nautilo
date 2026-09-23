/**
 * Tests for NautiloApiClient.
 *
 * Verifies the client has the expected methods for server communication.
 * Originated in ISSUE-006's client/server process separation work.
 *
 * M071 1B.8: `http://127.0.0.1:3001` here is an inert test fixture base URL,
 * not a duplicated runtime default — production callers pass `resolveInstance().server.url`.
 */

import { describe, test, expect } from "bun:test";
import { NautiloApiClient } from "../../src/client";

describe("NautiloApiClient", () => {
  const client = new NautiloApiClient("http://127.0.0.1:3001");

  test("has getHealth plus D104 account security client methods", () => {
    expect(typeof client.getHealth).toBe("function");
    expect(typeof client.getSetupStatus).toBe("function");
    expect(typeof client.getAccountSecurity).toBe("function");
    expect(typeof client.getAccountDeletionEligibility).toBe("function");
    expect(typeof client.deleteAccount).toBe("function");
    expect(typeof client.changePassword).toBe("function");
    expect(typeof client.getLogtoRecoveryCodeStatus).toBe("function");
    expect(typeof client.regenerateLogtoRecoveryCodes).toBe("function");
    expect(typeof client.getPinEnrollment).toBe("function");
    expect(typeof client.changePin).toBe("function");
    expect(typeof client.getSecurityPosture).toBe("function");
    expect(typeof client.updateSecurityPosture).toBe("function");
  });

  test("sends the uncontained-host-commands policy through the existing posture API", async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown;
    globalThis.fetch = (async (_url, init) => {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({
        deploymentMode: "desktop-permissive",
        securityLevel: "cautious",
        allowUncontainedHostCommands: true,
        networkPolicy: { mode: "host" },
        capabilities: ["manage_uncontained_host_commands"],
        actorRole: "owner",
        writablePaths: [],
        readOnlyPaths: [],
        backend: { kind: "passthrough" },
        changed: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await client.updateSecurityPosture({
        allowUncontainedHostCommands: true,
        pin: "246810",
      });
      expect(body).toEqual({ allowUncontainedHostCommands: true, pin: "246810" });
      expect(result.allowUncontainedHostCommands).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("has sendMessage method", () => {
    expect(typeof client.sendMessage).toBe("function");
  });

  test("has downloadArtifact (D144-P2)", () => {
    expect(typeof client.downloadArtifact).toBe("function");
  });

  test("has getProfile method", () => {
    expect(typeof client.getProfile).toBe("function");
  });

  test("has getMemoryBrief method", () => {
    expect(typeof client.getMemoryBrief).toBe("function");
  });

  test("has createBackgroundJob method", () => {
    expect(typeof client.createBackgroundJob).toBe("function");
  });

  test("has getModels method", () => {
    expect(typeof client.getModels).toBe("function");
    expect(typeof client.resolveRetainedModels).toBe("function");
  });

  test("retained-model client posts only the requested ids and purpose", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    globalThis.fetch = (async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await client.resolveRetainedModels(["legacy:one"], { purpose: "chat-tools" });
      expect(requestBody).toEqual({ ids: ["legacy:one"], purpose: "chat-tools" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getModels accepts public control metadata and rejects leaked provider selectors", async () => {
    const originalFetch = globalThis.fetch;
    const model = {
      id: "fireworks:accounts/fireworks/models/kimi-k3",
      displayName: "Kimi K3 (Fireworks)",
      provider: "fireworks",
      priority: 5,
      enabled: true,
      costCoefficient: 1,
      capabilities: { tools: true, vision: true, reasoning: false, e2ee: false, webSearch: false },
      controls: {
        serving: {
          defaultProfile: "standard",
          profiles: [{
            id: "fast",
            label: "Fast",
            intent: "throughput",
            pricing: { inputPerMtok: 4.5, cachedInputPerMtok: 0.45, outputPerMtok: 22.5 },
          }],
        },
      },
    };
    globalThis.fetch = (async () => new Response(JSON.stringify([model]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    try {
      const models = await client.getModels();
      expect(models[0]?.controls?.serving?.profiles[0]?.pricing?.outputPerMtok).toBe(22.5);

      globalThis.fetch = (async () => new Response(JSON.stringify([{
        ...model,
        controls: {
          ...model.controls,
          selector: { kind: "model-override", modelId: "should-not-cross-boundary" },
        },
      }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
      let rejected = false;
      try {
        await client.getModels();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("has proveItAndResume method", () => {
    expect(typeof client.proveItAndResume).toBe("function");
  });

  test("has denyProveIt method", () => {
    expect(typeof client.denyProveIt).toBe("function");
  });

  test("has verifyAndResume method", () => {
    expect(typeof client.verifyAndResume).toBe("function");
  });

  test("has M065 room list/detail/create methods", () => {
    expect(typeof client.listRooms).toBe("function");
    expect(typeof client.getRoom).toBe("function");
    expect(typeof client.createRoom).toBe("function");
    expect(typeof client.getRoomModelControlSelection).toBe("function");
    expect(typeof client.updateRoomModelControlSelection).toBe("function");
  });

  test("strictly parses room model-control selections", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push({
        url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return new Response(JSON.stringify({
        selection: { modelId: "fireworks:accounts/fireworks/models/kimi-k3", servingProfileId: "fast" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const selection = await client.getRoomModelControlSelection("room-1", "agent-1");
      expect(selection?.servingProfileId).toBe("fast");
      await client.updateRoomModelControlSelection("room-1", "agent-1", {
        modelId: "fireworks:accounts/fireworks/models/kimi-k3",
        servingProfileId: "priority",
      });
      expect(requests[1]).toEqual({
        url: "http://127.0.0.1:3001/api/rooms/room-1/agents/agent-1/model-control-selection",
        method: "PUT",
        body: JSON.stringify({
          selection: {
            modelId: "fireworks:accounts/fireworks/models/kimi-k3",
            servingProfileId: "priority",
          },
        }),
      });

      globalThis.fetch = (async () => new Response(JSON.stringify({
        selection: {
          modelId: "fireworks:accounts/fireworks/models/kimi-k3",
          providerSelector: "leaked",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
      let rejected = false;
      try {
        await client.getRoomModelControlSelection("room-1", "agent-1");
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("has M063 PIN / recovery helpers", () => {
    expect(typeof client.identityVerifyResume).toBe("function");
    expect(typeof client.getPinEnrollment).toBe("function");
    expect(typeof client.changePin).toBe("function");
    expect(typeof client.recoverPin).toBe("function");
    expect(typeof client.getRecoveryCodeStatus).toBe("function");
    expect(typeof client.regenerateRecoveryCodes).toBe("function");
    expect(typeof client.postAuthPin).toBe("function");
  });

  test("refreshes bearer from token provider before profile writes", async () => {
    const originalFetch = globalThis.fetch;
    const headersSeen: string[] = [];
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("expired-token");
    c.setTokenProvider(async () => "fresh-token");

    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers.get("authorization") ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await c.updateProfile({ defaultModel: "openai:gpt-5.5-2026-04-23" });
      expect(headersSeen).toEqual(["Bearer fresh-token"]);
      expect(c.getToken()).toBe("fresh-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("profile read uses the latched token instead of a transient null provider result", async () => {
    const originalFetch = globalThis.fetch;
    const headersSeen: string[] = [];
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("latched-token");
    c.setTokenProvider(async () => null);

    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers.get("authorization") ?? "");
      return new Response(JSON.stringify({ viewerRole: "owner", agent: { name: "Jeannie" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await c.getProfile();
      expect(headersSeen).toEqual(["Bearer latched-token"]);
      expect(c.getToken()).toBe("latched-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshes bearer from token provider before listing rooms", async () => {
    const originalFetch = globalThis.fetch;
    const headersSeen: string[] = [];
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setTokenProvider(async () => "fresh-room-token");

    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers.get("authorization") ?? "");
      return new Response(JSON.stringify({ rooms: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await c.listRooms();
      expect(headersSeen).toEqual(["Bearer fresh-room-token"]);
      expect(c.getToken()).toBe("fresh-room-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * D445 Phase 1 — provider-key admin client calls must ride the normal
 * session bearer (the routes are no longer in the trust-bypass list).
 * These tests assert the outgoing Authorization header is the latched
 * session token, and that submitted secrets / bootstrap tokens are
 * never echoed back in a response body the client surfaces.
 */
describe("NautiloApiClient provider-key auth contract (D445)", () => {
  // getKeySummary / validateKeys expect the raw route shapes:
  //   GET /api/health/keys  -> KeyReport[]
  //   POST /api/health/keys/validate -> { keys, summary }
  function captureFetch(headersSeen: string[], bodySeen: string[] = []) {
    return (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers(init?.headers);
      headersSeen.push(headers.get("authorization") ?? "");
      if (init?.body && typeof init.body === "string") bodySeen.push(init.body);
      const urlStr = typeof url === "string" ? url : String(url as URL);
      const payload = urlStr.endsWith("/api/health/keys")
        ? JSON.stringify([])
        : JSON.stringify({ keys: [], summary: { hasLlm: false } });
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  test("getKeySummary sends the session bearer (not auth:none)", async () => {
    const originalFetch = globalThis.fetch;
    const headersSeen: string[] = [];
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("session-bearer-d445");
    globalThis.fetch = captureFetch(headersSeen);
    try {
      await c.getKeySummary();
      expect(headersSeen).toEqual(["Bearer session-bearer-d445"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("validateKeys sends the session bearer", async () => {
    const originalFetch = globalThis.fetch;
    const headersSeen: string[] = [];
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("session-bearer-d445");
    globalThis.fetch = captureFetch(headersSeen);
    try {
      await c.validateKeys();
      expect(headersSeen).toEqual(["Bearer session-bearer-d445"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads and updates the bounded web-research provider with session authority", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ method: string; authorization: string; body: string }> = [];
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("session-bearer-research");
    globalThis.fetch = (async (_url, init) => {
      calls.push({
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({
        provider: "duckduckgo_html",
        tavilyConfigured: false,
      }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      expect(await c.getResearchProvider()).toEqual({
        provider: "duckduckgo_html",
        tavilyConfigured: false,
      });
      await c.updateResearchProvider("duckduckgo_html");
      expect(calls).toEqual([
        { method: "GET", authorization: "Bearer session-bearer-research", body: "" },
        { method: "PUT", authorization: "Bearer session-bearer-research", body: '{"provider":"duckduckgo_html"}' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("setupKeys sends the session bearer and the secret in the request body only", async () => {
    const originalFetch = globalThis.fetch;
    const headersSeen: string[] = [];
    const bodiesSeen: string[] = [];
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("session-bearer-d445");
    globalThis.fetch = captureFetch(headersSeen, bodiesSeen);
    try {
      await c.setupKeys({ ANTHROPIC_API_KEY: "sk-ant-do-not-echo" }, true);
      expect(headersSeen).toEqual(["Bearer session-bearer-d445"]);
      // The secret is sent to the server in the request body (write-only)...
      expect(bodiesSeen[0]).toContain("sk-ant-do-not-echo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getKeySummary surfaces the server response without echoing a submitted secret", async () => {
    const originalFetch = globalThis.fetch;
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("session-bearer-d445");
    // Server responds with masked keys only — never the raw secret.
    globalThis.fetch = (async () => {
      const payload = JSON.stringify([
        {
          id: "anthropic",
          envVar: "ANTHROPIC_API_KEY",
          status: "present",
          masked: "sk-ant-***",
        },
      ]);
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await c.getKeySummary();
      expect(result.hasLlm).toBe(true);
      expect(JSON.stringify(result)).not.toContain("sk-ant-do-not-echo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getKeySummary does not report a managed Gateway key as ready without its API root", async () => {
    const originalFetch = globalThis.fetch;
    const c = new NautiloApiClient("http://127.0.0.1:3001");
    c.setToken("session-bearer-d445");
    globalThis.fetch = (async () => new Response(JSON.stringify([
      {
        id: "nautilo-gateway",
        envVar: "NAUTILO_MANAGED_GATEWAY_API_KEY",
        status: "present",
        masked: "ngw_***",
      },
    ]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    try {
      const result = await c.getKeySummary();
      expect(result.hasLlm).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
