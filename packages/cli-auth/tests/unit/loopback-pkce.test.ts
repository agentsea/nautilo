/**
 * Unit tests for loopback PKCE helpers and `runLoopbackPkce` (M102).
 *
 * Uses test seams only — no real browser or network to Logto.
 */

import { describe, expect, test } from "bun:test";
import {
  generatePkcePair,
  generateState,
  runLoopbackPkce,
  startLoopbackServer,
  type LoopbackHandle,
} from "../../src/loopback-pkce";

const base64urlRe = /^[A-Za-z0-9_-]+$/;

function asFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return fn as typeof fetch;
}

function requestInputToUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function expectRejectsWith(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(msg).toMatch(pattern);
    return;
  }
  throw new Error("expected promise to reject");
}

describe("generatePkcePair", () => {
  test("verifier and challenge shapes; two calls differ", () => {
    const a = generatePkcePair();
    expect(a.codeVerifier.length).toBe(86);
    expect(a.codeChallenge.length).toBe(43);
    expect(a.codeVerifier).toMatch(base64urlRe);
    expect(a.codeChallenge).toMatch(base64urlRe);
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("generateState", () => {
  test("43-char base64url-ish token; two calls differ", () => {
    const s1 = generateState();
    expect(s1.length).toBe(43);
    expect(s1).toMatch(base64urlRe);
    const s2 = generateState();
    expect(s1).not.toBe(s2);
  });
});

describe("startLoopbackServer", () => {
  test("binds 127.0.0.1 with ephemeral port; shutdown rejects awaitCallback", async () => {
    const lb = await startLoopbackServer({ timeoutMs: 100 });
    expect(lb.address).toBe("127.0.0.1");
    expect(lb.port).toBeGreaterThan(0);
    lb.shutdown();
    await expectRejectsWith(lb.awaitCallback, /shut down/i);
  });

  test("resolves awaitCallback on /callback with code and state", async () => {
    const lb = await startLoopbackServer({ timeoutMs: 5000 });
    try {
      const p = fetch(
        `http://127.0.0.1:${lb.port}/callback?code=abc&state=xyz`,
      );
      await p;
      const cb = await lb.awaitCallback;
      expect(cb).toEqual({
        code: "abc",
        state: "xyz",
      });
    } finally {
      lb.shutdown();
    }
  });

  test("rejects awaitCallback on OAuth error query param", async () => {
    const lb = await startLoopbackServer({ timeoutMs: 5000 });
    try {
      const p = fetch(
        `http://127.0.0.1:${lb.port}/callback?error=access_denied`,
      );
      await p;
      await expectRejectsWith(lb.awaitCallback, /OAuth error/);
    } finally {
      lb.shutdown();
    }
  });

  test("two concurrent callbacks use distinct ephemeral ports", async () => {
    const first = await startLoopbackServer({ timeoutMs: 5_000 });
    const second = await startLoopbackServer({ timeoutMs: 5_000 });
    try {
      expect(first.address).toBe("127.0.0.1");
      expect(second.address).toBe("127.0.0.1");
      expect(first.port).not.toBe(second.port);
    } finally {
      first.shutdown();
      second.shutdown();
    }
    await expectRejectsWith(first.awaitCallback, /shut down/i);
    await expectRejectsWith(second.awaitCallback, /shut down/i);
  });

  test("times out and closes an unanswered callback", async () => {
    const loopback = await startLoopbackServer({ timeoutMs: 20 });
    await expectRejectsWith(loopback.awaitCallback, /callback timeout/i);
    loopback.shutdown();
  });
});

describe("runLoopbackPkce", () => {
  test("required browser launch failure closes the callback and rejects", async () => {
    let shutdownCalls = 0;
    const run = runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      browserLaunchRequired: true,
      startLoopback: async () => ({
        port: 4,
        address: "127.0.0.1",
        awaitCallback: new Promise(() => {}),
        shutdown: () => { shutdownCalls += 1; },
      }),
      openUrl: async () => { throw new Error("ENOENT"); },
    });

    await expectRejectsWith(run, /browser launch failed/i);
    expect(shutdownCalls).toBe(1);
  });

  test("happy path: openUrl + token exchange + result mapping", async () => {
    let resolveCb!: (v: { code: string; state: string }) => void;
    const awaitCallback = new Promise<{ code: string; state: string }>(
      (res) => {
        resolveCb = res;
      },
    );

    const fetchCalls: { url: string; init?: RequestInit }[] = [];

    const result = await runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      startLoopback: async (): Promise<LoopbackHandle> => ({
        port: 4242,
        address: "127.0.0.1",
        awaitCallback,
        shutdown: () => {
          /* stub */
        },
      }),
      openUrl: (url) => {
        const state = new URL(url).searchParams.get("state");
        if (!state) throw new Error("missing state in auth URL");
        resolveCb({ code: "test-code", state });
      },
      fetchImpl: asFetch(async (input, init) => {
        fetchCalls.push({
          url: requestInputToUrlString(input),
          ...(init !== undefined ? { init } : {}),
        });
        return Response.json({
          access_token: "at",
          refresh_token: "rt",
          id_token: "it",
          expires_in: 3600,
        });
      }),
    });

    expect(result).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      idToken: "it",
      expiresIn: 3600,
    });

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]?.url).toBe("http://logto.test/oidc/token");
    const body = fetchCalls[0]?.init?.body;
    expect(
      typeof body === "string" || body instanceof URLSearchParams,
    ).toBe(true);
    const params =
      body instanceof URLSearchParams
        ? body
        : new URLSearchParams(body as string);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("test-code");
    expect(params.get("redirect_uri")).toBe(
      "http://127.0.0.1:4242/callback",
    );
    expect(params.get("client_id")).toBe("test-app");
    expect(params.get("resource")).toBe("test-resource");
    expect(params.get("code_verifier")).toMatch(base64urlRe);
  });

  test("authorize URL contains required params; extraParams override prompt", async () => {
    let resolveCb!: (v: { code: string; state: string }) => void;
    const awaitCallback = new Promise<{ code: string; state: string }>(
      (res) => {
        resolveCb = res;
      },
    );

    let seenAuthUrl = "";

    await runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      extraParams: { prompt: "login consent", max_age: "60" },
      startLoopback: async () => ({
        port: 9,
        address: "127.0.0.1",
        awaitCallback,
        shutdown: () => {},
      }),
      openUrl: (url) => {
        seenAuthUrl = url;
        const state = new URL(url).searchParams.get("state");
        if (!state) throw new Error("missing state");
        resolveCb({ code: "c", state });
      },
      fetchImpl: asFetch(async () =>
        Response.json({
          access_token: "a",
          expires_in: 1,
        }),
      ),
    });

    const u = new URL(seenAuthUrl);
    expect(u.pathname).toBe("/oidc/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("test-app");
    expect(seenAuthUrl).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback",
    );
    const scope = u.searchParams.get("scope") ?? "";
    expect(scope.split(/\s+/).filter(Boolean).sort().join(" ")).toBe(
      "email offline_access openid profile",
    );
    expect(u.searchParams.get("resource")).toBe("test-resource");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("prompt")).toBe("login consent");
    expect(u.searchParams.get("max_age")).toBe("60");
    expect(u.searchParams.get("code_challenge")).toMatch(base64urlRe);
  });

  test("default authorize URL uses prompt=login consent", async () => {
    let resolveCb!: (v: { code: string; state: string }) => void;
    const awaitCallback = new Promise<{ code: string; state: string }>(
      (res) => {
        resolveCb = res;
      },
    );
    let seenAuthUrl = "";
    await runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      startLoopback: async () => ({
        port: 7,
        address: "127.0.0.1",
        awaitCallback,
        shutdown: () => {},
      }),
      openUrl: (url) => {
        seenAuthUrl = url;
        const state = new URL(url).searchParams.get("state");
        if (!state) throw new Error("missing state");
        resolveCb({ code: "c", state });
      },
      fetchImpl: asFetch(async () =>
        Response.json({ access_token: "a", expires_in: 1 }),
      ),
    });
    expect(new URL(seenAuthUrl).searchParams.get("prompt")).toBe("login consent");
  });

  test("state mismatch throws", async () => {
    let resolveCb!: (v: { code: string; state: string }) => void;
    const awaitCallback = new Promise<{ code: string; state: string }>(
      (res) => {
        resolveCb = res;
      },
    );

    const run = runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      startLoopback: async () => ({
        port: 1,
        address: "127.0.0.1",
        awaitCallback,
        shutdown: () => {},
      }),
      openUrl: () => {
        resolveCb({ code: "x", state: "wrong" });
      },
      fetchImpl: asFetch(async () =>
        Response.json({ access_token: "a", expires_in: 1 }),
      ),
    });

    await expectRejectsWith(run, /state mismatch/i);
  });

  test("token exchange failure surfaces status and body", async () => {
    let resolveCb!: (v: { code: string; state: string }) => void;
    const awaitCallback = new Promise<{ code: string; state: string }>(
      (res) => {
        resolveCb = res;
      },
    );

    const run = runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      startLoopback: async () => ({
        port: 1,
        address: "127.0.0.1",
        awaitCallback,
        shutdown: () => {},
      }),
      openUrl: (url) => {
        const state = new URL(url).searchParams.get("state");
        if (!state) throw new Error("missing state");
        resolveCb({ code: "c", state });
      },
      fetchImpl: asFetch(async () =>
        new Response("bad_grant", { status: 400, statusText: "Bad" }),
      ),
    });

    await expectRejectsWith(
      run,
      /token exchange failed: 400 bad_grant/i,
    );
  });

  test("already-aborted signal: throws and shuts down loopback", async () => {
    const ac = new AbortController();
    ac.abort();

    let shutdownCalls = 0;
    const hang = new Promise<{ code: string; state: string }>(() => {});

    const run = runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      abortSignal: ac.signal,
      startLoopback: async () => ({
        port: 1,
        address: "127.0.0.1",
        awaitCallback: hang,
        shutdown: () => {
          shutdownCalls += 1;
        },
      }),
      openUrl: () => {},
      fetchImpl: asFetch(async () => Response.json({})),
    });

    await expectRejectsWith(run, /aborted/i);
    expect(shutdownCalls).toBeGreaterThanOrEqual(1);
  });

  test("omits refreshToken and idToken when absent from token JSON", async () => {
    let resolveCb!: (v: { code: string; state: string }) => void;
    const awaitCallback = new Promise<{ code: string; state: string }>(
      (res) => {
        resolveCb = res;
      },
    );

    const result = await runLoopbackPkce({
      endpoint: "http://logto.test",
      clientId: "test-app",
      resource: "test-resource",
      startLoopback: async () => ({
        port: 2,
        address: "127.0.0.1",
        awaitCallback,
        shutdown: () => {},
      }),
      openUrl: (url) => {
        const state = new URL(url).searchParams.get("state");
        if (!state) throw new Error("missing state");
        resolveCb({ code: "c", state });
      },
      fetchImpl: asFetch(async () =>
        Response.json({ access_token: "only", expires_in: 60 }),
      ),
    });

    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["accessToken", "expiresIn"]);
  });
});
