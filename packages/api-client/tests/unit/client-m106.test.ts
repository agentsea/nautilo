import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  NautiloApiClient,
  OwnerClaimAmbiguousWriteError,
  OwnerClaimApiError,
} from "../../src/client";

function reqUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("NautiloApiClient M106 auth + invite flows", () => {
  const base = "http://127.0.0.1:3001";
  const exactRecoveryCodes = Array.from(
    { length: 8 },
    (_, index) => index.toString(16).padStart(24, "0"),
  );
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("recoverPinWithFreshJwt POST /api/auth/recover with { newPin } and bearer", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("fresh-jwt");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/auth/recover`);
      expect(init?.method).toBe("POST");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer fresh-jwt");
      expect(h.get("content-type")).toBe("application/json");
      expect(JSON.parse((init?.body ?? "") as string)).toEqual({ newPin: "123456" });
      return new Response(JSON.stringify({ ok: true, codesRemaining: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.recoverPinWithFreshJwt("123456");
    expect(out).toEqual({ ok: true, codesRemaining: 7 });
  });

  test("recoverPinWithFreshJwt 401 fresh_reauth_required uses server message", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("stale");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "fresh_reauth_required",
          message: "Step up required.",
          maxAgeMs: 60000,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await client.recoverPinWithFreshJwt("123456");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(401);
      expect(err.message).toBe("Step up required.");
    }
  });

  test("recoverPinWithFreshJwt 401 without fresh_reauth_required", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.recoverPinWithFreshJwt("123456");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("Authentication required");
    }
  });

  test("recoverPasswordWithCode POST localhost route without bearer, returns relay session", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("ignored");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/account/password/recover-with-code`);
      expect(init?.method).toBe("POST");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBeNull();
      expect(h.get("content-type")).toBe("application/json");
      expect(JSON.parse((init?.body ?? "") as string)).toEqual({
        handle: "alice",
        recoveryCode: "code-1",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: "sess-1",
          sessionToken: "tok-1",
          resetUrl: "https://logto.example/forgot-password",
          email: "alice@nautilo.local",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await client.recoverPasswordWithCode({
      handle: "alice",
      recoveryCode: "code-1",
    });
    expect(out).toEqual({
      ok: true,
      sessionId: "sess-1",
      sessionToken: "tok-1",
      resetUrl: "https://logto.example/forgot-password",
      email: "alice@nautilo.local",
    });
  });

  test("recoverPasswordWithCode sends only { handle, recoveryCode } (no password)", async () => {
    const client = new NautiloApiClient(base);

    let observedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      observedBody = JSON.parse((init?.body ?? "") as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          ok: true,
          sessionId: "s",
          sessionToken: "t",
          resetUrl: "https://logto.example/forgot-password",
          email: "alice@nautilo.local",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await client.recoverPasswordWithCode({ handle: "alice", recoveryCode: "code-1" });
    expect(observedBody).toEqual({ handle: "alice", recoveryCode: "code-1" });
    expect(observedBody).not.toHaveProperty("newPassword");
  });

  test("recoverPasswordWithCode 400 surfaces invalid_handle distinctly", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_handle", code: "invalid_handle" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await client.recoverPasswordWithCode({ handle: "Bad-Handle!", recoveryCode: "x" });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toBe("invalid_handle");
    }
  });

  test("recoverPasswordWithCode 400 uses body.error or Invalid input", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Recovery request could not be completed." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.recoverPasswordWithCode({ handle: "alice", recoveryCode: "x" });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toBe("Recovery request could not be completed.");
    }
  });

  test("recoverPasswordWithCode 403 maps to localhost-only message", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.recoverPasswordWithCode({ handle: "alice", recoveryCode: "x" });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).message).toBe(
        "Password recovery with a code is only allowed from localhost.",
      );
    }
  });

  test("getRecoveryRelayCode GETs the relay path with the session token bearer", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/account/password/recovery-relay/sess-1`);
      expect(init?.method).toBe("GET");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer tok-1");
      return new Response(JSON.stringify({ status: "ready", code: "424242" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.getRecoveryRelayCode({ sessionId: "sess-1", sessionToken: "tok-1" });
    expect(out).toEqual({ status: "ready", code: "424242" });
  });

  test("getRecoveryRelayCode returns pending while Logto has not delivered", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "pending" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const out = await client.getRecoveryRelayCode({ sessionId: "s", sessionToken: "t" });
    expect(out).toEqual({ status: "pending" });
  });

  test("getRecoveryRelayCode fails closed on a malformed ready response (no code)", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    let threw = false;
    try {
      await client.getRecoveryRelayCode({ sessionId: "s", sessionToken: "t" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("prepareLogtoSignup POST encoded path and { handle } body (M107)", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(
        `${base}/api/invites/inv_abc%2Fslash/prepare-logto-signup`,
      );
      expect(init?.method).toBe("POST");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBeNull();
      // M107: body carries { handle }, never { email }.
      expect(JSON.parse((init?.body ?? "") as string)).toEqual({ handle: "alice" });
      return new Response(
        JSON.stringify({ state: "st", handle: "alice" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await client.prepareLogtoSignup("inv_abc/slash", {
      handle: "alice",
    });
    expect(out.state).toBe("st");
    expect(out.handle).toBe("alice");
  });

  test("owner-claim methods keep capability material in protected POST bodies, never request paths", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("at");
    const claim = `inv_${"a".repeat(32)}`;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const urlText = reqUrl(url);
      calls.push(init === undefined ? { url: urlText } : { url: urlText, init });
      const path = new URL(reqUrl(url)).pathname;
      if (path === "/api/owner-claim/preview") {
        // Deliberately omit `continuation`: an upgraded Workbench must
        // normalize an older server response into new-owner, not choose a
        // legacy renderer path.
        return new Response(JSON.stringify({
          kind: "claim",
          inviterHandle: "Nautilo",
          expiresAt: null,
          usesRemaining: 1,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/owner-claim/prepare-auth") {
        return new Response(JSON.stringify({
          continuation: "new-owner",
          state: "opaque-new-owner",
          handle: "owner",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/owner-claim/prepare-logto-signup") {
        return new Response(JSON.stringify({ state: "opaque", handle: "owner" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/setup/owner-claim/redeem") {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          state: "owner-bound",
          recoveryCodes: exactRecoveryCodes,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, recoveryCodes: [], landingRoomId: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const preview = await client.previewOwnerClaim({ claim });
    expect(preview?.continuation).toBe("new-owner");
    await client.prepareOwnerClaimAuth({ claim, handle: "owner" });
    // This remains a wire-compatibility endpoint for in-flight old clients;
    // the new coordinator uses prepare-auth above instead of falling back to it.
    await client.prepareOwnerClaimLogtoSignup({ claim, handle: "owner" });
    await client.redeemOwnerClaim({
      claim,
      handle: "owner",
      displayName: "Owner",
      password: "permanent-password",
      pin: "123456",
    });
    await client.completeOwnerClaimProfile({ claim, displayName: "Owner", pin: "123456" });

    expect(calls.map(({ url }) => url)).toEqual([
      `${base}/api/owner-claim/preview`,
      `${base}/api/owner-claim/prepare-auth`,
      `${base}/api/owner-claim/prepare-logto-signup`,
      `${base}/api/setup/owner-claim/redeem`,
      `${base}/api/owner-claim/complete-profile`,
    ]);
    expect(calls.every(({ url }) => !url.includes(claim))).toBe(true);
    const bodies = calls.map((call) => {
      const body = call.init?.body;
      expect(typeof body).toBe("string");
      return JSON.parse(body as string) as unknown;
    });
    expect(bodies[0]).toEqual({ claim });
    expect(bodies[1]).toEqual({ claim, handle: "owner" });
    expect(bodies[2]).toEqual({ claim, handle: "owner" });
    expect(bodies[3]).toEqual({
      schemaVersion: 1,
      claim,
      handle: "owner",
      displayName: "Owner",
      password: "permanent-password",
      pin: "123456",
    });
    expect(bodies[4]).toEqual({
      claim,
      displayName: "Owner",
      pin: "123456",
    });
  });

  test("direct owner seed uses an injected transport and validates its exact one-time result", async () => {
    const claim = `inv_${"c".repeat(32)}`;
    const transportCalls: Array<{ url: string; body: unknown }> = [];
    const client = new NautiloApiClient(base, {
      fetchImpl: (async (url, init) => {
        if (typeof init?.body !== "string") throw new Error("expected JSON request body");
        transportCalls.push({
          url: reqUrl(url),
          body: JSON.parse(init.body) as unknown,
        });
        return new Response(JSON.stringify({
          schemaVersion: 1,
          state: "owner-bound",
          recoveryCodes: exactRecoveryCodes,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    expect(await client.redeemOwnerClaim({
      claim,
      handle: "owner",
      displayName: "Owner",
      password: "permanent-password",
      pin: "123456",
    })).toEqual({
      schemaVersion: 1,
      state: "owner-bound",
      recoveryCodes: exactRecoveryCodes,
    });
    expect(transportCalls).toEqual([{
      url: `${base}/api/setup/owner-claim/redeem`,
      body: {
        schemaVersion: 1,
        claim,
        handle: "owner",
        displayName: "Owner",
        password: "permanent-password",
        pin: "123456",
      },
    }]);

    expect(() => new NautiloApiClient(base, {
      unixSocketPath: "/tmp/nautilo.sock",
      fetchImpl: globalThis.fetch,
    })).toThrow("mutually exclusive");
  });

  test("direct owner seed treats missing, empty, or widened recovery results as ambiguous", async () => {
    const claim = `inv_${"d".repeat(32)}`;
    for (const body of [
      { schemaVersion: 1, state: "owner-bound", recoveryCodes: [] },
      { schemaVersion: 1, state: "owner-bound", recoveryCodes: exactRecoveryCodes, extra: true },
      { schemaVersion: 1, state: "claim-active", recoveryCodes: exactRecoveryCodes },
    ]) {
      const client = new NautiloApiClient(base, {
        fetchImpl: (async () => new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
      });
      try {
        await client.redeemOwnerClaim({
          claim,
          handle: "owner",
          displayName: "Owner",
          password: "permanent-password",
          pin: "123456",
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(OwnerClaimAmbiguousWriteError);
        expect((error as OwnerClaimAmbiguousWriteError).operation).toBe("redeem");
      }
    }
  });

  test("owner-claim preview validates the browser contract strictly before a coordinator can act", async () => {
    const client = new NautiloApiClient(base);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      kind: "claim",
      inviterHandle: "Nautilo",
      expiresAt: null,
      usesRemaining: 1,
      continuation: "resume-owner",
      unexpected: true,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    try {
      await client.previewOwnerClaim({ claim: `inv_${"b".repeat(32)}` });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("prepareLogtoSignup 400 surfaces invalid_handle distinctly (M107)", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_handle", code: "invalid_handle" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await client.prepareLogtoSignup("inv_x", { handle: "Bad!" });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toBe("invalid_handle");
    }
  });

  test("prepareLogtoSignup 404 throws not_found", async () => {
    const client = new NautiloApiClient(base);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.prepareLogtoSignup("inv_x", { handle: "alice" });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(404);
      expect((e as ApiError).message).toBe("not_found");
    }
  });

  test("bindLogtoUser POST /api/bind-logto-user with bearer and state", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("logto-at");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/bind-logto-user`);
      expect(init?.method).toBe("POST");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer logto-at");
      expect(JSON.parse((init?.body ?? "") as string)).toEqual({ state: "opaque" });
      return new Response(
        JSON.stringify({
          ok: true,
          actorId: "act_1",
          userId: "usr_1",
          requiresProfileCompletion: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await client.bindLogtoUser({ state: "opaque" });
    expect(out).toEqual({
      ok: true,
      actorId: "act_1",
      userId: "usr_1",
      requiresProfileCompletion: true,
    });
  });

  test("bindLogtoUser 422 invalid_state", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_state", code: "invalid_state" }),
        { status: 422, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await client.bindLogtoUser({ state: "bad" });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(422);
      expect((e as ApiError).message).toBe("invalid_state");
    }
  });

  test("bindLogtoUser preserves the server's claim_reserved 409 as a typed error", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("reserved-account");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "claim_reserved", code: "claim_reserved" }),
        { status: 409, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    try {
      await client.bindLogtoUser({ state: "opaque" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerClaimApiError);
      expect((error as OwnerClaimApiError).status).toBe(409);
      expect((error as OwnerClaimApiError).code).toBe("claim_reserved");
      expect((error as OwnerClaimApiError).serverCode).toBe("claim_reserved");
    }
  });

  test("bindLogtoUser preserves every documented route and bind-result failure code", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("owner-access-token");
    // These are the exact `{ error, code }` envelopes emitted by the bind
    // route itself and by redeemInviteWithLogtoSub's result union.
    const cases = [
      [400, "missing_handle"],
      [400, "invalid_handle"],
      [400, "invalid_display_name"],
      [400, "invalid_logto_sub"],
      [401, "missing_bearer"],
      [401, "invalid_token"],
      [404, "logto_user_not_found"],
      [404, "not_found"],
      [409, "handle_mismatch"],
      [409, "claim_reserved"],
      [409, "handle_taken"],
      [410, "expired"],
      [410, "revoked"],
      [410, "used_up"],
      [422, "invalid_state"],
      [500, "claim_reservation_invariant"],
      [500, "user_actor_invariant"],
      [502, "logto_lookup_failed"],
      [503, "logto_unconfigured"],
    ] as const;

    for (const [status, code] of cases) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: code, code }), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      try {
        await client.bindLogtoUser({ state: "opaque" });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(OwnerClaimApiError);
        expect((error as OwnerClaimApiError).status).toBe(status);
        expect((error as OwnerClaimApiError).code).toBe(code);
        expect((error as OwnerClaimApiError).serverCode).toBe(code);
      }
    }
  });

  test("owner completion preserves canonical conflict codes instead of a generic Conflict", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("owner-access-token");

    for (const code of ["not_bound", "already_completed"] as const) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: code, code }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      try {
        await client.completeOwnerClaimProfile({
          claim: `inv_${"a".repeat(32)}`,
          displayName: "Owner",
          pin: "123456",
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(OwnerClaimApiError);
        expect((error as OwnerClaimApiError).status).toBe(409);
        expect((error as OwnerClaimApiError).code).toBe(code);
      }
    }
  });

  test("completion preserves documented validation and legacy handle mismatch codes", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("owner-access-token");

    const cases: Array<{
      readonly call: () => Promise<unknown>;
      readonly code: string;
      readonly status: number;
    }> = [
      {
        call: () => client.completeOwnerClaimProfile({
          claim: `inv_${"a".repeat(32)}`,
          displayName: "Owner",
          pin: "123456",
        }),
        code: "invalid_pin",
        status: 400,
      },
      {
        // `handle_mismatch` is emitted by the legacy ordinary complete route;
        // the body-only owner endpoint deliberately has no handle input.
        call: () => client.completeInviteProfile("inv_tok", {
          displayName: "Owner",
          pin: "123456",
        }),
        code: "handle_mismatch",
        status: 409,
      },
    ];

    for (const { call, code, status } of cases) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: code, code }), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      try {
        await call();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(OwnerClaimApiError);
        expect((error as OwnerClaimApiError).status).toBe(status);
        expect((error as OwnerClaimApiError).code).toBe(code);
      }
    }
  });

  test("owner writes turn unobservable outcomes into typed reobserve failures", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("owner-access-token");

    globalThis.fetch = (async () => {
      throw new Error("connection reset after request body write");
    }) as unknown as typeof fetch;

    try {
      await client.completeOwnerClaimProfile({
        claim: `inv_${"a".repeat(32)}`,
        displayName: "Owner",
        pin: "123456",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerClaimAmbiguousWriteError);
      expect((error as OwnerClaimAmbiguousWriteError).code).toBe("ambiguous_write");
      expect((error as OwnerClaimAmbiguousWriteError).recovery).toBe("reobserve");
      expect((error as OwnerClaimAmbiguousWriteError).operation).toBe("complete-profile");
    }
  });

  test("malformed successful owner completion is an ambiguous write, never a synthetic success", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("owner-access-token");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, recoveryCodes: ["not-a-string"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.completeOwnerClaimProfile({
        claim: `inv_${"a".repeat(32)}`,
        displayName: "Owner",
        pin: "123456",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerClaimAmbiguousWriteError);
      expect((error as OwnerClaimAmbiguousWriteError).recovery).toBe("reobserve");
    }
  });

  test("strict owner schemas reject malformed preview and prepare responses before orchestration", async () => {
    const client = new NautiloApiClient(base);
    const claim = `inv_${"a".repeat(32)}`;
    const calls = [
      {
        run: () => client.previewOwnerClaim({ claim }),
        body: { kind: "claim", continuation: "invented", usesRemaining: 1 },
      },
      {
        run: () => client.prepareOwnerClaimAuth({ claim, handle: "owner" }),
        body: { continuation: "new-owner", state: "", handle: "owner", extra: "not-allowed" },
      },
    ];

    for (const { run, body } of calls) {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
      let rejected = false;
      try {
        await run();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
  });

  test("a malformed successful bind is ambiguous and requires canonical reobservation", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("owner-access-token");
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    try {
      await client.bindLogtoUser({ state: "opaque" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerClaimAmbiguousWriteError);
      expect((error as OwnerClaimAmbiguousWriteError).operation).toBe("bind");
      expect((error as OwnerClaimAmbiguousWriteError).recovery).toBe("reobserve");
    }
  });

  test("completeInviteProfile POST complete-profile with bearer and fields", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("at");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites/inv_tok/complete-profile`);
      expect(init?.method).toBe("POST");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer at");
      // M107: handle no longer in the body; pinned at bind time.
      expect(JSON.parse((init?.body ?? "") as string)).toEqual({
        displayName: "D",
        pin: "123456",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          recoveryCodes: ["a", "b"],
          landingRoomId: "room_1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await client.completeInviteProfile("inv_tok", {
      displayName: "D",
      pin: "123456",
    });
    expect(out.ok).toBe(true);
    expect(out.recoveryCodes).toEqual(["a", "b"]);
    expect(out.landingRoomId).toBe("room_1");
  });

  test("completeInviteProfile normalizes null landingRoomId", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("at");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          recoveryCodes: [],
          landingRoomId: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const out = await client.completeInviteProfile("inv_tok", {
      displayName: "D",
      pin: "123456",
    });
    expect(out.landingRoomId).toBeNull();
  });

  test("completeInviteProfile 401 invalid_token", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("bad");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.completeInviteProfile("inv_tok", {
        displayName: "D",
        pin: "123456",
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(401);
      expect((e as ApiError).message).toBe("invalid_token");
    }
  });
});
