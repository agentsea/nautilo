import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  authorizeRailwayOAuth,
  RAILWAY_OAUTH_AUTHORIZATION_ENDPOINT,
  RAILWAY_OAUTH_DISCOVERY_URL,
  RAILWAY_OAUTH_DURABLE_SCOPES,
  RAILWAY_OAUTH_ISSUER,
  RAILWAY_OAUTH_MEMORY_SCOPES,
  RAILWAY_OAUTH_CLIENT_ID,
  RAILWAY_OAUTH_REDIRECT_URI,
  RAILWAY_OAUTH_TOKEN_ENDPOINT,
  startRailwayOAuthLoopback,
  type RailwayOAuthCallback,
  type RailwayOAuthCredentialStore,
  type RailwayOAuthLoopbackFactory,
  type RailwayOAuthLoopbackRequest,
  type RailwayOAuthRefreshLease,
  type RailwayOAuthStoredCredential,
} from "../../src/index";

function requestForm(body: unknown): URLSearchParams {
  if (!(body instanceof URLSearchParams)) throw new Error("expected URL-encoded token form");
  return body;
}

function deferredLoopback(): {
  readonly factory: RailwayOAuthLoopbackFactory;
  readonly resolve: (callback: RailwayOAuthCallback) => void;
  readonly requests: RailwayOAuthLoopbackRequest[];
  readonly closeCalls: { count: number };
} {
  let resolve!: (callback: RailwayOAuthCallback) => void;
  const callback = new Promise<RailwayOAuthCallback>((done) => {
    resolve = done;
  });
  const requests: RailwayOAuthLoopbackRequest[] = [];
  const closeCalls = { count: 0 };
  return {
    resolve,
    requests,
    closeCalls,
    factory: (request) => {
      requests.push(request);
      return Promise.resolve({
        outcome: "listening",
        handle: {
          callback,
          close: () => {
            closeCalls.count += 1;
            return Promise.resolve();
          },
        },
      });
    },
  };
}

class ExclusiveTestStore implements RailwayOAuthCredentialStore {
  credential: RailwayOAuthStoredCredential | null;
  readonly refreshInputs: string[] = [];
  maxActiveLeases = 0;
  #activeLeases = 0;
  #locked = false;
  readonly #waiters: Array<() => void> = [];

  constructor(credential: RailwayOAuthStoredCredential | null) {
    this.credential = credential;
  }

  get activeLeases(): number {
    return this.#activeLeases;
  }

  acquireExclusiveRefreshLease(): Promise<RailwayOAuthRefreshLease> {
    return new Promise((resolve) => {
      const grant = () => {
        this.#locked = true;
        this.#activeLeases += 1;
        this.maxActiveLeases = Math.max(this.maxActiveLeases, this.#activeLeases);
        const initial = this.credential;
        let authorityGeneration = initial?.generation ?? null;
        let active = true;
        resolve({
          credential: initial,
          replace: (next) => {
            const currentGeneration = this.credential?.generation ?? null;
            if (!active || currentGeneration !== authorityGeneration) {
              return Promise.resolve("stale-lease");
            }
            this.credential = next;
            authorityGeneration = next.generation;
            return Promise.resolve("stored");
          },
          clear: () => {
            const currentGeneration = this.credential?.generation ?? null;
            if (!active || currentGeneration !== authorityGeneration) {
              return Promise.resolve("stale-lease");
            }
            this.credential = null;
            authorityGeneration = null;
            return Promise.resolve("cleared");
          },
          release: () => {
            if (!active) return Promise.resolve();
            active = false;
            this.#activeLeases -= 1;
            this.#locked = false;
            const next = this.#waiters.shift();
            if (next !== undefined) queueMicrotask(next);
            return Promise.resolve();
          },
        });
      };
      if (this.#locked) this.#waiters.push(grant);
      else grant();
    });
  }
}

function tokenResponse(
  scopes: readonly string[],
  refreshToken?: string,
): Response {
  return Response.json({
    access_token: "access-token-never-render",
    expires_in: 3600,
    token_type: "Bearer",
    scope: scopes.join(" "),
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
  });
}

describe("Railway native OAuth contract", () => {
  test("pins the registered Native/Public client and official discovery authority", () => {
    expect(RAILWAY_OAUTH_CLIENT_ID).toBe("rlwy_oaci_m3o2YCnliWf67k5awTIZ7HUW");
    expect(RAILWAY_OAUTH_DISCOVERY_URL).toBe(
      "https://backboard.railway.com/oauth/.well-known/openid-configuration",
    );
    expect(RAILWAY_OAUTH_REDIRECT_URI).toBe("http://127.0.0.1:43877/callback");
  });

  test("memory-only auth omits offline_access, closes loopback before exchange, and never accepts a refresh token", async () => {
    const loopback = deferredLoopback();
    let authorizationUrl: URL | undefined;
    let tokenForm: URLSearchParams | undefined;
    let fetchSawClosed = false;
    let fetchSawSignal = false;

    const result = await authorizeRailwayOAuth({
      interactive: true,
      startLoopback: loopback.factory,
      openBrowser: (rawUrl) => {
        authorizationUrl = new URL(rawUrl);
        const request = loopback.requests[0];
        if (request === undefined) throw new Error("listener must start before browser");
        loopback.resolve({
          outcome: "code",
          code: "single-use-code",
          state: request.expectedState,
          issuer: request.expectedIssuer,
        });
      },
      fetch: async (input, init) => {
        expect(String(input)).toBe(RAILWAY_OAUTH_TOKEN_ENDPOINT);
        fetchSawClosed = loopback.closeCalls.count === 1;
        fetchSawSignal = init?.signal instanceof AbortSignal;
        tokenForm = requestForm(init?.body);
        return tokenResponse(RAILWAY_OAUTH_MEMORY_SCOPES);
      },
      now: () => 10_000,
    });

    expect(result).toMatchObject({
      outcome: "authorized",
      expiresAt: 3_610_000,
      persistence: "memory-only",
    });
    if (authorizationUrl === undefined || tokenForm === undefined) {
      throw new Error("expected authorization request and token exchange");
    }
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(RAILWAY_OAUTH_AUTHORIZATION_ENDPOINT);
    expect(authorizationUrl.searchParams.get("scope")).toBe(RAILWAY_OAUTH_MEMORY_SCOPES.join(" "));
    expect(authorizationUrl.searchParams.get("scope")).not.toContain("offline_access");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl.searchParams.has("client_secret")).toBe(false);
    expect(loopback.requests[0]?.expectedState).toBe(
      authorizationUrl.searchParams.get("state") ?? undefined,
    );
    expect(loopback.requests[0]?.expectedIssuer).toBe(RAILWAY_OAUTH_ISSUER);
    expect(fetchSawClosed).toBe(true);
    expect(fetchSawSignal).toBe(true);

    expect(tokenForm.get("grant_type")).toBe("authorization_code");
    expect(tokenForm.get("redirect_uri")).toBe(RAILWAY_OAUTH_REDIRECT_URI);
    expect(tokenForm.get("client_id")).toBe(RAILWAY_OAUTH_CLIENT_ID);
    expect(tokenForm.has("client_secret")).toBe(false);
    const verifier = tokenForm.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      authorizationUrl.searchParams.get("code_challenge") ?? "",
    );
    expect(JSON.stringify(result)).not.toContain("access-token-never-render");
  });

  test("memory-only mode rejects a provider refresh token instead of discarding it", async () => {
    const loopback = deferredLoopback();
    const result = await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: true,
      startLoopback: loopback.factory,
      openBrowser: () => {
        const request = loopback.requests[0];
        if (request === undefined) throw new Error("missing listener request");
        loopback.resolve({
          outcome: "code",
          code: "single-use-code",
          state: request.expectedState,
          issuer: request.expectedIssuer,
        });
      },
      fetch: () => Promise.resolve(tokenResponse(RAILWAY_OAUTH_MEMORY_SCOPES, "unexpected-refresh")),
    });
    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "token-response-invalid", repair: "reauthorize-railway" },
    });
    expect(JSON.stringify(result)).not.toContain("unexpected-refresh");
  });

  test("durable initial auth requests offline_access and atomically stores generation one", async () => {
    const store = new ExclusiveTestStore(null);
    const loopback = deferredLoopback();
    let requestedScopes = "";
    const result = await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: true,
      credentialStore: store,
      startLoopback: loopback.factory,
      openBrowser: (rawUrl) => {
        requestedScopes = new URL(rawUrl).searchParams.get("scope") ?? "";
        const request = loopback.requests[0];
        if (request === undefined) throw new Error("missing listener request");
        loopback.resolve({
          outcome: "code",
          code: "single-use-code",
          state: request.expectedState,
          issuer: request.expectedIssuer,
        });
      },
      fetch: () => Promise.resolve(tokenResponse(RAILWAY_OAUTH_DURABLE_SCOPES, "durable-refresh")),
    });
    expect(result).toMatchObject({ outcome: "authorized", persistence: "os-credential-store" });
    expect(requestedScopes).toBe(RAILWAY_OAUTH_DURABLE_SCOPES.join(" "));
    expect(requestedScopes).toContain("offline_access");
    expect(store.credential).toEqual({ refreshToken: "durable-refresh", generation: 1 });
    expect(store.maxActiveLeases).toBe(1);
  });

  test("holds one exclusive lease across refresh exchange and atomic rotation", async () => {
    const store = new ExclusiveTestStore({ refreshToken: "refresh-zero", generation: 1 });
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    let fetchCount = 0;
    const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      const form = requestForm(init?.body);
      const incoming = form.get("refresh_token") ?? "";
      store.refreshInputs.push(incoming);
      fetchCount += 1;
      if (fetchCount === 1) await firstBlocked;
      return tokenResponse(RAILWAY_OAUTH_DURABLE_SCOPES, `refresh-${fetchCount}`);
    };

    const first = authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: false,
      credentialStore: store,
      fetch: fetchImpl,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: false,
      credentialStore: store,
      fetch: fetchImpl,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.refreshInputs).toEqual(["refresh-zero"]);
    expect(store.maxActiveLeases).toBe(1);

    unblockFirst();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.outcome === "authorized")).toBe(true);
    expect(store.refreshInputs).toEqual(["refresh-zero", "refresh-1"]);
    expect(store.credential).toEqual({ refreshToken: "refresh-2", generation: 3 });
    expect(store.maxActiveLeases).toBe(1);
  });

  test("clears invalid_grant only through the still-current exclusive lease", async () => {
    const store = new ExclusiveTestStore({ refreshToken: "revoked-refresh", generation: 4 });
    const result = await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: false,
      credentialStore: store,
      fetch: () => Promise.resolve(Response.json(
        { error: "invalid_grant", error_description: "provider detail" },
        { status: 400 },
      )),
    });
    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "refresh-revoked", repair: "reauthorize-railway" },
    });
    expect(store.credential).toBeNull();
    expect(JSON.stringify(result)).not.toContain("revoked-refresh");
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  test("fails closed when a lease cannot prove generation-safe clear authority", async () => {
    let released = false;
    const store: RailwayOAuthCredentialStore = {
      acquireExclusiveRefreshLease: () => Promise.resolve({
        credential: { refreshToken: "stale-refresh", generation: 9 },
        replace: () => Promise.resolve("stale-lease"),
        clear: () => Promise.resolve("stale-lease"),
        release: () => {
          released = true;
          return Promise.resolve();
        },
      }),
    };
    const result = await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: false,
      credentialStore: store,
      fetch: () => Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })),
    });
    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "refresh-conflict", repair: "reauthorize-railway" },
    });
    expect(released).toBe(true);
    expect(JSON.stringify(result)).not.toContain("stale-refresh");
  });

  test("requires the exact conditional scope set", async () => {
    for (const scopes of [
      RAILWAY_OAUTH_MEMORY_SCOPES.slice(0, -1),
      [...RAILWAY_OAUTH_MEMORY_SCOPES, "offline_access"],
    ]) {
      const loopback = deferredLoopback();
      const result = await authorizeRailwayOAuth({
        clientId: RAILWAY_OAUTH_CLIENT_ID,
        interactive: true,
        startLoopback: loopback.factory,
        openBrowser: () => {
          const request = loopback.requests[0];
          if (request === undefined) throw new Error("missing listener request");
          loopback.resolve({
            outcome: "code",
            code: "single-use-code",
            state: request.expectedState,
            issuer: request.expectedIssuer,
          });
        },
        fetch: () => Promise.resolve(tokenResponse(scopes)),
      });
      expect(result).toMatchObject({ outcome: "failure", failure: { kind: "insufficient-scope" } });
    }
  });

  test("aborts a bounded token request after closing the listener", async () => {
    const loopback = deferredLoopback();
    let signal: AbortSignal | undefined;
    let fetchSawClosed = false;
    const result = await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: true,
      tokenTimeoutMs: 5,
      startLoopback: loopback.factory,
      openBrowser: () => {
        const request = loopback.requests[0];
        if (request === undefined) throw new Error("missing listener request");
        loopback.resolve({
          outcome: "code",
          code: "single-use-code",
          state: request.expectedState,
          issuer: request.expectedIssuer,
        });
      },
      fetch: (_input, init) => {
        fetchSawClosed = loopback.closeCalls.count === 1;
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "token-request-timeout", repair: "retry-browser-authorization" },
    });
    expect(fetchSawClosed).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(loopback.closeCalls.count).toBe(1);
  });

  test("aborts a bounded refresh while retaining then releasing its exclusive lease", async () => {
    const store = new ExclusiveTestStore({ refreshToken: "refresh-zero", generation: 1 });
    let signal: AbortSignal | undefined;
    const result = await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: false,
      credentialStore: store,
      tokenTimeoutMs: 5,
      fetch: (_input, init) => {
        expect(store.activeLeases).toBe(1);
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    expect(result).toEqual({
      outcome: "failure",
      failure: { kind: "token-request-timeout", repair: "retry-later" },
    });
    expect(signal?.aborted).toBe(true);
    expect(store.activeLeases).toBe(0);
    expect(store.credential).toEqual({ refreshToken: "refresh-zero", generation: 1 });
  });

  test("JSON/noninteractive mode and a missing browser never bind a listener", async () => {
    let loopbackCalls = 0;
    const factory: RailwayOAuthLoopbackFactory = () => {
      loopbackCalls += 1;
      return Promise.resolve({ outcome: "port-unavailable" });
    };
    expect(await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: false,
      startLoopback: factory,
    })).toEqual({
      outcome: "failure",
      failure: { kind: "reauthorization-required", repair: "run-in-interactive-terminal" },
    });
    expect(await authorizeRailwayOAuth({
      clientId: RAILWAY_OAUTH_CLIENT_ID,
      interactive: true,
      startLoopback: factory,
    })).toEqual({
      outcome: "failure",
      failure: { kind: "browser-open-failed", repair: "retry-browser-authorization" },
    });
    expect(loopbackCalls).toBe(0);
  });
});

describe("Railway state-bound fixed loopback server", () => {
  test("hostile callback races do not consume or settle the valid callback", async () => {
    const expectedState = "expected-state";
    const result = await startRailwayOAuthLoopback({
      timeoutMs: 2_000,
      expectedState,
      expectedIssuer: RAILWAY_OAUTH_ISSUER,
    });
    expect(result.outcome).toBe("listening");
    if (result.outcome !== "listening") throw new Error("registered callback port is occupied");
    let settled = false;
    void result.handle.callback.then(() => {
      settled = true;
    });
    try {
      const missing = new URL(RAILWAY_OAUTH_REDIRECT_URI);
      const wrongState = new URL(RAILWAY_OAUTH_REDIRECT_URI);
      wrongState.searchParams.set("code", "hostile-code");
      wrongState.searchParams.set("state", "wrong-state");
      wrongState.searchParams.set("iss", RAILWAY_OAUTH_ISSUER);
      const wrongIssuer = new URL(RAILWAY_OAUTH_REDIRECT_URI);
      wrongIssuer.searchParams.set("code", "hostile-code");
      wrongIssuer.searchParams.set("state", expectedState);
      wrongIssuer.searchParams.set("iss", "https://attacker.invalid");
      const malformed = new URL(RAILWAY_OAUTH_REDIRECT_URI);
      malformed.searchParams.set("code", "hostile-code");
      malformed.searchParams.set("error", "access_denied");
      malformed.searchParams.set("state", expectedState);
      malformed.searchParams.set("iss", RAILWAY_OAUTH_ISSUER);
      const valid = new URL(RAILWAY_OAUTH_REDIRECT_URI);
      valid.searchParams.set("code", "accepted-code");
      valid.searchParams.set("state", expectedState);
      valid.searchParams.set("iss", RAILWAY_OAUTH_ISSUER);

      for (const hostile of [missing, wrongState, wrongIssuer, malformed]) {
        const response = await fetch(hostile);
        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain("connected. You can close");
        await Promise.resolve();
        expect(settled).toBe(false);
      }

      const [racedHostile, accepted] = await Promise.all([
        fetch(wrongState),
        fetch(valid),
      ]);
      expect(accepted.status).toBe(200);
      expect([400, 409]).toContain(racedHostile.status);
      expect(await result.handle.callback).toEqual({
        outcome: "code",
        code: "accepted-code",
        state: expectedState,
        issuer: RAILWAY_OAUTH_ISSUER,
      });
      expect(await accepted.text()).toContain("connected. You can close");

      const replay = await fetch(valid);
      expect(replay.status).toBe(409);
      expect(await replay.text()).not.toContain("accepted-code");
    } finally {
      await result.handle.close();
    }
  });

  test("a valid denial is redacted and accepted only with bound state and issuer", async () => {
    const result = await startRailwayOAuthLoopback({
      timeoutMs: 2_000,
      expectedState: "expected-state",
      expectedIssuer: RAILWAY_OAUTH_ISSUER,
    });
    if (result.outcome !== "listening") throw new Error("registered callback port is occupied");
    try {
      const denied = new URL(RAILWAY_OAUTH_REDIRECT_URI);
      denied.searchParams.set("error", "access_denied");
      denied.searchParams.set("error_description", "sensitive-provider-detail");
      denied.searchParams.set("state", "expected-state");
      denied.searchParams.set("iss", RAILWAY_OAUTH_ISSUER);
      const response = await fetch(denied);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("sensitive-provider-detail");
      expect(await result.handle.callback).toEqual({
        outcome: "denied",
        state: "expected-state",
        issuer: RAILWAY_OAUTH_ISSUER,
      });
    } finally {
      await result.handle.close();
    }
  });
});
