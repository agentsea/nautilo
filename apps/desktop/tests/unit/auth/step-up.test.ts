/**
 * M101 — `runStepUp` orchestrator (PKCE + loopback + token exchange).
 */
import { describe, expect, test } from "bun:test";
import { runStepUp } from "../../../electron/auth/step-up";
import type { LoopbackHandle } from "../../../electron/auth/loopback-server";
import type { TokenBundle } from "../../../electron/auth/token-store";

describe("runStepUp", () => {
  test("authorize URL uses prompt=login, max_age=60, no offline_access, correct redirect_uri", async () => {
    let openedUrl = "";
    const fetchCalls: { url: string; body: string }[] = [];
    const saved: TokenBundle[] = [];
    const stateValueHolder: { state?: string } = {};
    const port = 51234;

    const startLoopback = async (): Promise<LoopbackHandle> => ({
      port,
      awaitCallback: new Promise<{ code: string; state: string }>((resolve) => {
        const tick = () => {
          if (stateValueHolder.state) {
            resolve({ code: "AUTHCODE", state: stateValueHolder.state! });
          } else {
            setTimeout(tick, 1);
          }
        };
        tick();
      }),
      shutdown: () => {},
    });

    const iat = 1_700_000_000;
    const jwtPayloadB64 = Buffer.from(JSON.stringify({ iat }), "utf8").toString(
      "base64url",
    );

    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body
            ? init.body.toString()
            : "";
      fetchCalls.push({ url, body });
      const accessToken = ["hdr", jwtPayloadB64, "sig"].join(".");
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: "rt",
          id_token: "it",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await runStepUp(
      {
        openAuthUrl: async (url) => {
          openedUrl = url;
          const parsed = new URL(url);
          stateValueHolder.state = parsed.searchParams.get("state") ?? "";
          return { closeAuthSurface: () => {} };
        },
        startLoopback,
        fetchImpl,
        saveTokens: async (b) => {
          saved.push(b);
        },
        config: {
          endpoint: "https://logto.test",
          clientId: "desktop-app-id",
          resource: "https://api.example.test",
        },
        generatePkce: async () => ({
          verifier: "verifier123",
          challenge: "challenge456",
        }),
        generateState: () => "state789",
      },
      {},
    );

    const parsed = new URL(openedUrl);
    expect(parsed.searchParams.get("prompt")).toBe("login");
    expect(parsed.searchParams.get("max_age")).toBe("60");
    expect(parsed.searchParams.get("client_id")).toBe("desktop-app-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${port}/callback`,
    );
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("openid");
    expect(scope).not.toContain("offline_access");

    expect(fetchCalls[0]?.url).toBe("https://logto.test/oidc/token");
    expect(fetchCalls[0]?.body).toContain("grant_type=authorization_code");
    expect(fetchCalls[0]?.body).toContain("code=AUTHCODE");
    expect(fetchCalls[0]?.body).toContain("code_verifier=verifier123");
    expect(fetchCalls[0]?.body).toContain("client_id=desktop-app-id");
    expect(fetchCalls[0]?.body).toContain(
      "resource=https%3A%2F%2Fapi.example.test",
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]?.access_token.split(".")[1]).toBe(jwtPayloadB64);
    expect(result.issuedAt).toBe(iat);
  });

  test("honours custom maxAgeSeconds", async () => {
    let openedUrl = "";
    const stateValueHolder: { state?: string } = {};
    const startLoopback = async (): Promise<LoopbackHandle> => ({
      port: 55555,
      awaitCallback: new Promise<{ code: string; state: string }>((resolve) => {
        const tick = () => {
          if (stateValueHolder.state) {
            resolve({ code: "C", state: stateValueHolder.state! });
          } else {
            setTimeout(tick, 1);
          }
        };
        tick();
      }),
      shutdown: () => {},
    });

    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          access_token: "a.b.c",
          refresh_token: "r",
          id_token: "i",
          expires_in: 60,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await runStepUp(
      {
        openAuthUrl: async (url) => {
          openedUrl = url;
          stateValueHolder.state = new URL(url).searchParams.get("state") ?? "";
          return { closeAuthSurface: () => {} };
        },
        startLoopback,
        fetchImpl,
        saveTokens: async () => {},
        config: { endpoint: "http://x", clientId: "id", resource: "res" },
        generatePkce: async () => ({ verifier: "v", challenge: "ch" }),
        generateState: () => "st",
      },
      { maxAgeSeconds: 120 },
    );

    expect(new URL(openedUrl).searchParams.get("max_age")).toBe("120");
  });

  test("loopback rejection becomes step_up_cancelled with code cancelled", async () => {
    const startLoopback = async (): Promise<LoopbackHandle> => ({
      port: 1,
      awaitCallback: Promise.reject(new Error("timeout")),
      shutdown: () => {},
    });

    let threw: Error | null = null;
    try {
      await runStepUp(
        {
          openAuthUrl: async () => ({ closeAuthSurface: () => {} }),
          startLoopback,
          fetchImpl: globalThis.fetch,
          saveTokens: async () => {},
          config: { endpoint: "http://x", clientId: "i", resource: "r" },
          generatePkce: async () => ({ verifier: "v", challenge: "c" }),
          generateState: () => "s",
        },
        {},
      );
    } catch (e) {
      threw = e as Error;
    }
    expect(threw?.message).toBe("step_up_cancelled");
    expect((threw as Error & { code?: string })?.code).toBe("cancelled");
  });

  test("saveTokens called exactly once on success", async () => {
    let saveCount = 0;
    const startLoopback = async (): Promise<LoopbackHandle> => ({
      port: 42,
      awaitCallback: Promise.resolve({ code: "cc", state: "ss" }),
      shutdown: () => {},
    });
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          access_token: "x.y.z",
          refresh_token: "rt",
          id_token: "it",
          expires_in: 100,
        }),
        { status: 200 },
      )) as typeof fetch;

    await runStepUp(
      {
        openAuthUrl: async () => ({ closeAuthSurface: () => {} }),
        startLoopback,
        fetchImpl,
        saveTokens: async () => {
          saveCount += 1;
        },
        config: { endpoint: "http://logto", clientId: "cid", resource: "aud" },
        generatePkce: async () => ({ verifier: "vv", challenge: "cc" }),
        generateState: () => "ss",
      },
      {},
    );
    expect(saveCount).toBe(1);
  });
});
