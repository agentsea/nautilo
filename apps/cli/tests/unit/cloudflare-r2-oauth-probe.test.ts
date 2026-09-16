import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_OAUTH_AUTHORIZATION_ENDPOINT,
  CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI,
  CLOUDFLARE_OAUTH_REVOKE_ENDPOINT,
  CLOUDFLARE_OAUTH_TOKEN_ENDPOINT,
  startCloudflareOAuthProbeCallback,
  runCloudflareR2OAuthProbe,
  type CloudflareOAuthCallbackHandle,
  type CloudflareR2OAuthProbeOptions,
  type CloudflareR2SessionPort,
} from "../../src/lib/cloudflare-r2-oauth-probe";

const CLIENT_ID = "nautilo-private-oauth-client";
const ACCOUNT_ID = "a".repeat(32);
const R2_SCOPE = "workers-r2-storage.write";
const ACCESS = "access-secret-canary";
const REFRESH = "refresh-secret-canary";
const ROTATED_ACCESS = "rotated-access-secret-canary";
const ROTATED_REFRESH = "rotated-refresh-secret-canary";

type FailureAt =
  | "temporary"
  | "session"
  | "s3-put"
  | "s3-head"
  | "s3-get"
  | "s3-delete"
  | "refresh";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function callback(code = "authorization-code"): CloudflareOAuthCallbackHandle {
  return {
    callback: Promise.resolve({ outcome: "code", code }),
    close: async () => undefined,
  };
}

function token(accessToken: string, refreshToken: string | undefined, scope = R2_SCOPE): unknown {
  return {
    access_token: accessToken,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    token_type: "Bearer",
    expires_in: 900,
    scope,
  };
}

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("unexpected-request-body");
}

function harness(options: {
  readonly failureAt?: FailureAt;
  readonly malformedToken?: boolean;
  readonly accessOnly?: boolean;
  readonly mismatchedScope?: boolean;
  readonly cleanupMissing?: boolean;
  readonly deleteFails?: boolean;
  readonly preexisting?: boolean;
  readonly createResponseLost?: boolean;
  readonly temporaryStatus?: 400 | 403 | 429 | 500;
  readonly temporaryTransportLost?: boolean;
  readonly tokenVerification?: "transport-lost" | "server-error" | "malformed";
  readonly postRevoke?: "invalid-grant" | "transport-lost" | "server-error" | "malformed";
  readonly postRevokeAccessActive?: boolean;
  readonly callbackOutcome?: "denied" | "invalid" | "timeout";
  readonly onStart?: (probeOptions: CloudflareR2OAuthProbeOptions) => void;
} = {}) {
  const events: string[] = [];
  const stored = new Map<string, Uint8Array>();
  let authorizeUrl: URL | undefined;
  let bucket: string | undefined;
  let refreshCount = 0;
  let revocationRequested = false;
  const revocationTokens: string[] = [];
  const session: CloudflareR2SessionPort = {
    put: async ({ key, body }) => {
      events.push("s3-put");
      if (options.failureAt === "s3-put") throw new Error("s3-put-failed");
      stored.set(key, body.slice());
    },
    head: async ({ key }) => {
      events.push("s3-head");
      if (options.failureAt === "s3-head") throw new Error("s3-head-failed");
      return stored.get(key)?.byteLength ?? -1;
    },
    get: async ({ key }) => {
      events.push("s3-get");
      if (options.failureAt === "s3-get") throw new Error("s3-get-failed");
      return stored.get(key)?.slice() ?? new Uint8Array();
    },
    delete: async ({ key }) => {
      events.push("s3-delete");
      if (options.failureAt === "s3-delete") throw new Error("s3-delete-failed");
      stored.delete(key);
    },
  };
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === CLOUDFLARE_OAUTH_TOKEN_ENDPOINT) {
      const form = new URLSearchParams(requestBody(init));
      if (form.get("grant_type") === "authorization_code") {
        events.push("token-code");
        const verifier = form.get("code_verifier");
        expect(verifier).toBeString();
        const expectedChallenge = authorizeUrl?.searchParams.get("code_challenge");
        if (expectedChallenge === null || expectedChallenge === undefined) throw new Error("missing-challenge");
        expect(createHash("sha256").update(verifier!).digest("base64url"))
          .toBe(expectedChallenge);
        return response(options.malformedToken
          ? { access_token: ACCESS }
          : token(ACCESS, options.accessOnly ? undefined : REFRESH,
            options.mismatchedScope ? "workers-r2.read" : undefined));
      }
      events.push("token-refresh");
      if (revocationRequested) {
        if (options.postRevoke === "transport-lost") throw new Error("post-revoke-transport-lost");
        if (options.postRevoke === "server-error") return response({ error: "server_error" }, 500);
        if (options.postRevoke === "malformed") return response({ error: "other" }, 400);
        return response({ error: "invalid_grant" }, 400);
      }
      refreshCount += 1;
      if (options.failureAt === "refresh" && refreshCount === 1) {
        return response({ error: "invalid_grant" }, 400);
      }
      return refreshCount === 1
        ? response(token(ROTATED_ACCESS, ROTATED_REFRESH))
        : response({ error: "invalid_grant" }, 400);
    }
    if (url === `${CLOUDFLARE_API_BASE}/user/tokens/verify`) {
      if (revocationRequested) {
        events.push("verify-revoked");
        if (options.postRevoke === "transport-lost") throw new Error("post-revoke-access-transport-lost");
        if (options.postRevoke === "server-error") return response({ success: false }, 500);
        if (options.postRevoke === "malformed") return response({ success: true }, 401);
        if (options.postRevokeAccessActive) {
          return response({ success: true, result: { id: "p".repeat(32) }, errors: [], messages: [] });
        }
        expect(init?.headers).toEqual({
          authorization: `Bearer ${
            options.failureAt === "refresh" || options.mismatchedScope ||
              options.accessOnly || options.malformedToken
              ? ACCESS
              : ROTATED_ACCESS
          }`,
        });
        return response({ success: false, errors: [{ code: 1000 }], messages: [] }, 401);
      }
      events.push("verify");
      if (options.tokenVerification === "transport-lost") throw new Error("token-verification-transport-lost");
      if (options.tokenVerification === "server-error") return response({ success: false }, 500);
      if (options.tokenVerification === "malformed") return response({ success: true, result: {} });
      expect(init?.headers).toEqual({ authorization: `Bearer ${ACCESS}` });
      return response({ success: true, result: { id: "p".repeat(32) }, errors: [], messages: [] });
    }
    if (url === `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT_ID}/r2/buckets` && init?.method === "POST") {
      events.push("bucket-create");
      const body = JSON.parse(requestBody(init)) as { name: string; storageClass: string };
      expect(body.storageClass).toBe("Standard");
      bucket = body.name;
      expect(bucket).toMatch(/^nautilo-oauth-probe-[a-f0-9]{16}$/);
      if (options.createResponseLost) throw new Error("create-response-lost");
      return response({ success: true, result: { name: bucket }, errors: [], messages: [] });
    }
    if (url === `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`) {
      events.push("temporary");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ authorization: `Bearer ${ACCESS}`, "content-type": "application/json" });
      expect(JSON.parse(requestBody(init))).toEqual({
        bucket,
        parentAccessKeyId: "p".repeat(32),
        permission: "object-read-write",
        ttlSeconds: 900,
        prefixes: ["nautilo-oauth-probe/"],
      });
      if (options.temporaryTransportLost) throw new Error("temporary-transport-lost");
      return options.failureAt === "temporary" || options.temporaryStatus !== undefined
        ? response({ success: false, errors: [{ code: 1000 }] }, options.temporaryStatus ?? 403)
        : response({
            success: true,
            result: {
              accessKeyId: "temporary-access-canary",
              secretAccessKey: "temporary-secret-canary",
              sessionToken: "temporary-session-canary",
            },
            errors: [],
            messages: [],
          });
    }
    if (url === `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT_ID}/r2/buckets/${bucket}` && init?.method === "DELETE") {
      events.push("bucket-delete");
      expect(init?.headers).toEqual({
        authorization: `Bearer ${options.failureAt === "refresh" || options.accessOnly ? ACCESS : ROTATED_ACCESS}`,
      });
      return options.deleteFails
        ? response({ success: false, errors: [{ code: 10006 }] }, 409)
        : response({ success: true, result: {}, errors: [], messages: [] });
    }
    const bucketPrefix = `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT_ID}/r2/buckets/`;
    if (url.startsWith(bucketPrefix) && init?.method === "GET") {
      const requestedBucket = url.slice(bucketPrefix.length);
      if (bucket === undefined) {
        events.push("bucket-preflight");
        expect(requestedBucket).toMatch(/^nautilo-oauth-probe-[a-f0-9]{16}$/);
        return options.preexisting
          ? response({ success: true, result: { name: "preexisting" }, errors: [], messages: [] })
          : response({ success: false, errors: [{ code: 10006 }] }, 404);
      }
      events.push("bucket-observe");
      expect(requestedBucket).toBe(bucket);
      return options.cleanupMissing
        ? response({ success: true, result: { name: bucket }, errors: [], messages: [] })
        : response({ success: false, errors: [{ code: 10006 }] }, 404);
    }
    if (url === CLOUDFLARE_OAUTH_REVOKE_ENDPOINT) {
      events.push("revoke");
      revocationRequested = true;
      const form = new URLSearchParams(requestBody(init));
      expect(form.get("client_id")).toBe(CLIENT_ID);
      const token = form.get("token");
      if (token === null) throw new Error("missing-revocation-token");
      revocationTokens.push(token);
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const probeOptions: CloudflareR2OAuthProbeOptions = {
    clientId: CLIENT_ID,
    accountId: ACCOUNT_ID,
    r2WriteScope: R2_SCOPE,
    fetch: fetch as typeof globalThis.fetch,
    startCallback: async () => {
      options.onStart?.(probeOptions);
      return options.callbackOutcome === undefined
        ? callback()
        : {
            callback: Promise.resolve({ outcome: options.callbackOutcome }),
            close: async () => undefined,
          };
    },
    openBrowser: (url) => {
      authorizeUrl = new URL(url);
      events.push("authorize");
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(CLOUDFLARE_OAUTH_AUTHORIZATION_ENDPOINT);
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI);
      expect(authorizeUrl.searchParams.get("scope")).toBe(R2_SCOPE);
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    },
    createSession: async (request) => {
      events.push("session");
      expect(request.endpoint).toBe(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`);
      if (bucket === undefined) throw new Error("missing-bucket");
      expect(request.bucket).toBe(bucket);
      expect(Object.keys(request.credentials).sort()).toEqual(["accessKeyId", "secretAccessKey", "sessionToken"]);
      if (options.failureAt === "session") throw new Error("session-failed");
      return session;
    },
    randomBytes: (size) => new Uint8Array(size).fill(size),
  };
  return {
    events,
    revocationTokens,
    run: () => runCloudflareR2OAuthProbe(probeOptions),
  };
}

describe("Cloudflare R2 OAuth feasibility probe", () => {
  test("proves PKCE, OAuth-parent temporary credentials, bucket-bound S3 parity, cleanup, refresh, and revoke", async () => {
    const h = harness();
    const result = await h.run();
    expect(result).toEqual({ outcome: "passed", code: "passed", bucketAbsent: true, authorizationRevoked: true });
    expect(h.events).toEqual([
      "authorize", "token-code", "verify", "bucket-preflight", "bucket-create", "temporary", "session",
      "s3-put", "s3-head", "s3-get", "s3-delete", "token-refresh",
      "bucket-delete", "bucket-observe", "revoke", "revoke", "token-refresh", "verify-revoked",
    ]);
    expect(h.revocationTokens).toEqual([ROTATED_ACCESS, ROTATED_REFRESH]);
    expect(JSON.stringify(result)).not.toContain("canary");
  });

  test("accepts Cloudflare's access-token-only response and still proves revocation", async () => {
    const h = harness({ accessOnly: true });
    const result = await h.run();
    expect(result).toEqual({ outcome: "passed", code: "passed", bucketAbsent: true, authorizationRevoked: true });
    expect(h.events).toEqual([
      "authorize", "token-code", "verify", "bucket-preflight", "bucket-create", "temporary", "session",
      "s3-put", "s3-head", "s3-get", "s3-delete",
      "bucket-delete", "bucket-observe", "revoke", "verify-revoked",
    ]);
    expect(h.revocationTokens).toEqual([ACCESS]);
  });

  test("snapshots the original caller authority and capabilities before callback-controlled mutation", async () => {
    const h = harness({
      onStart: (probeOptions) => {
        const mutable = probeOptions as unknown as {
          clientId: string;
          accountId: string;
          r2WriteScope: string;
          openBrowser: (url: string) => Promise<void>;
          createSession: () => Promise<never>;
          fetch: typeof globalThis.fetch;
          startCallback: () => Promise<null>;
          randomBytes: () => never;
        };
        mutable.clientId = "mutated-client";
        mutable.accountId = "b".repeat(32);
        mutable.r2WriteScope = "mutated.scope";
        mutable.openBrowser = async () => { throw new Error("mutated-browser"); };
        mutable.createSession = async () => { throw new Error("mutated-session"); };
        mutable.fetch = ((() => { throw new Error("mutated-fetch"); }) as unknown) as typeof globalThis.fetch;
        mutable.startCallback = async () => null;
        mutable.randomBytes = () => { throw new Error("mutated-random"); };
      },
    });
    expect(await h.run()).toEqual({ outcome: "passed", code: "passed", bucketAbsent: true, authorizationRevoked: true });
    expect(h.events).toContain("session");
  });

  test.each(["temporary", "session", "s3-put", "s3-head", "s3-get", "s3-delete", "refresh"] as const)(
    "cleans up and revokes after each post-bucket failure: %s",
    async (failureAt) => {
      const h = harness({ failureAt });
      const result = await h.run();
      expect(result.outcome).toBe("failed");
      if (failureAt === "temporary") expect(result.code).toBe("oauth-token-not-r2-parent");
      expect(result.bucketAbsent).toBe(true);
      expect(result.authorizationRevoked).toBe(true);
      expect(h.events).toContain("bucket-delete");
      expect(h.events).toContain("bucket-observe");
      expect(h.events).toContain("revoke");
    },
  );

  test("fails closed when cleanup response is malformed, unsuccessful, or absence cannot be observed", async () => {
    for (const options of [{ cleanupMissing: true }, { deleteFails: true }]) {
      const h = harness(options);
      expect(await h.run()).toEqual({
        outcome: "failed",
        code: "cleanup-failed",
        bucketAbsent: false,
        authorizationRevoked: true,
      });
    }
  });

  test("cleans up the exact random bucket when create may have committed but its response is lost", async () => {
    const h = harness({ createResponseLost: true });
    expect(await h.run()).toEqual({
      outcome: "failed",
      code: "bucket-create-failed",
      bucketAbsent: true,
      authorizationRevoked: true,
    });
    expect(h.events).toEqual([
      "authorize", "token-code", "verify", "bucket-preflight", "bucket-create",
      "token-refresh", "bucket-delete", "bucket-observe", "revoke", "revoke", "token-refresh", "verify-revoked",
    ]);
  });

  test("does not create or delete when the exact random bucket already exists", async () => {
    const h = harness({ preexisting: true });
    expect(await h.run()).toEqual({
      outcome: "failed",
      code: "bucket-name-collision",
      bucketAbsent: false,
      authorizationRevoked: true,
    });
    expect(h.events).toEqual([
      "authorize", "token-code", "verify", "bucket-preflight",
      "token-refresh", "revoke", "revoke", "token-refresh", "verify-revoked",
    ]);
  });

  test.each([
    { temporaryStatus: 429 as const },
    { temporaryStatus: 500 as const },
    { temporaryTransportLost: true },
  ])("does not mistake transient temporary-credential failure for an OAuth-parent no-go: %#", async (options) => {
    const h = harness(options);
    expect(await h.run()).toEqual({
      outcome: "failed",
      code: "temporary-credentials-failed",
      bucketAbsent: true,
      authorizationRevoked: true,
    });
    expect(h.events).toContain("bucket-delete");
    expect(h.events).toContain("revoke");
  });

  test.each(["transport-lost", "server-error", "malformed"] as const)(
    "does not claim OAuth revocation without the exact post-revoke invalid_grant proof: %s",
    async (postRevoke) => {
      const h = harness({ postRevoke });
      expect(await h.run()).toEqual({
        outcome: "failed",
        code: "revocation-failed",
        bucketAbsent: true,
        authorizationRevoked: false,
      });
      expect(h.events).toContain("revoke");
    },
  );

  test("does not claim full authorization revocation while the access token remains usable", async () => {
    const h = harness({ postRevokeAccessActive: true });
    expect(await h.run()).toEqual({
      outcome: "failed",
      code: "revocation-failed",
      bucketAbsent: true,
      authorizationRevoked: false,
    });
    expect(h.events).toContain("verify-revoked");
    expect(h.revocationTokens).toEqual([ROTATED_ACCESS, ROTATED_REFRESH]);
  });

  test.each(["transport-lost", "server-error", "malformed"] as const)(
    "does not turn failed OAuth token verification into a parent-key no-go: %s",
    async (tokenVerification) => {
      const h = harness({ tokenVerification });
      expect(await h.run()).toEqual({
        outcome: "failed",
        code: "token-verification-failed",
        bucketAbsent: true,
        authorizationRevoked: true,
      });
      expect(h.events).toEqual([
        "authorize", "token-code", "verify", "token-refresh",
        "revoke", "revoke", "token-refresh", "verify-revoked",
      ]);
    },
  );

  test("revokes a retained access token from a malformed success response before failing", async () => {
    const h = harness({ malformedToken: true });
    expect(await h.run()).toEqual({
      outcome: "failed",
      code: "token-exchange-failed",
      bucketAbsent: true,
      authorizationRevoked: true,
    });
    expect(h.events).toEqual(["authorize", "token-code", "revoke", "verify-revoked"]);
    expect(h.revocationTokens).toEqual([ACCESS]);
  });

  test("reports revocation failure when a malformed success token cannot be proven revoked", async () => {
    const h = harness({ malformedToken: true, postRevoke: "transport-lost" });
    expect(await h.run()).toEqual({
      outcome: "failed",
      code: "revocation-failed",
      bucketAbsent: true,
      authorizationRevoked: false,
    });
    expect(h.events).toContain("revoke");
    expect(h.revocationTokens).toEqual([ACCESS]);
  });

  test("fails closed on a successful token response with an inexact granted scope set", async () => {
    const h = harness({ mismatchedScope: true });
    expect(await h.run()).toEqual({
      outcome: "failed",
      code: "scope-mismatch",
      bucketAbsent: true,
      authorizationRevoked: true,
    });
    expect(h.events).toEqual(["authorize", "token-code", "revoke", "revoke", "token-refresh", "verify-revoked"]);
    expect(h.revocationTokens).toEqual([ACCESS, REFRESH]);
  });

  test("does not cross a browser/callback boundary after denied, invalid, or timed-out authorization", async () => {
    for (const callbackOutcome of ["denied", "invalid", "timeout"] as const) {
      const h = harness({ callbackOutcome });
      const result = await h.run();
      expect(result.outcome).toBe("failed");
      expect(result.code).toBe(callbackOutcome === "denied"
        ? "authorization-denied"
        : callbackOutcome === "timeout" ? "callback-timeout" : "callback-invalid");
      expect(h.events).toEqual(["authorize"]);
    }
  });

  test("rejects malformed authority before browser, network, or S3 effects", async () => {
    let effects = 0;
    const result = await runCloudflareR2OAuthProbe({
      clientId: CLIENT_ID,
      accountId: "not-an-account",
      r2WriteScope: R2_SCOPE,
      openBrowser: () => { effects += 1; },
      createSession: () => { effects += 1; throw new Error("must not run"); },
      fetch: ((() => { effects += 1; throw new Error("must not run"); }) as unknown) as typeof globalThis.fetch,
    });
    expect(result).toEqual({ outcome: "failed", code: "invalid-input", bucketAbsent: true, authorizationRevoked: false });
    expect(effects).toBe(0);
  });

  test("callback accepts one exact state and rejects mix-up or replay", async () => {
    const state = "state-canary";
    const handle = await startCloudflareOAuthProbeCallback(state);
    expect(handle).not.toBeNull();
    try {
      const mismatch = await fetch(`${CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI}?code=bad&state=wrong`);
      expect(mismatch.status).toBe(400);
      const accepted = await fetch(`${CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI}?code=good&state=${state}`);
      expect(accepted.status).toBe(200);
      expect(await handle!.callback).toEqual({ outcome: "code", code: "good" });
      const replay = await fetch(`${CLOUDFLARE_OAUTH_PROBE_REDIRECT_URI}?code=again&state=${state}`);
      expect(replay.status).toBe(409);
    } finally {
      await handle?.close();
    }
  });

  test("qualification script refuses to run without the exact live-confirmation fence", async () => {
    const child = Bun.spawn(["bun", "scripts/qualify-cloudflare-r2-oauth.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const output = await new Response(child.stdout).text();
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      outcome: "unconfirmed",
      next: "supply-private-oauth-client-and-explicit-live-confirmation",
    });
  });
});
