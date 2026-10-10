import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, InviteShareApiError, NautiloApiClient } from "../../src/client";

function reqUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("NautiloApiClient invite list + revoke (M106)", () => {
  const base = "http://127.0.0.1:3001";
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("createInvite validates the handoff and normalizes an older receipt", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites`);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({
        id: "invite-id",
        url: "https://nautilo.example/redeem/inv_secret",
        token: "inv_secret",
        kind: "server",
        expiresAt: null,
        maxUses: 1,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.createInvite({
      kind: "server",
      targetGroupRoleSlug: "member",
      maxUses: 1,
    });
    expect(out.mutation).toEqual({
      stateChanged: true,
      auditRecorded: "unknown",
      retrySafe: false,
      receiptId: "invite-id",
      recovery: [{ kind: "revoke_invite", inviteId: "invite-id" }],
    });
  });

  test("listMyInvites calls GET /api/invites and returns parsed envelope", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites`);
      expect(init?.method ?? "GET").toBe("GET");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer t");
      return new Response(
        JSON.stringify({
          invites: [
            {
              id: "inv_1",
              kind: "server",
              maxUses: 1,
              usedCount: 0,
              expiresAt: null,
              revokedAt: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              displayName: null,
              targetRoomId: null,
              targetRoomLabel: null,
              targetRoleSlug: "member",
              codeAvailable: true,
            },
            {
              id: "claim_1",
              kind: "claim",
              maxUses: 1,
              usedCount: 0,
              expiresAt: null,
              revokedAt: null,
              createdAt: "2025-12-31T00:00:00.000Z",
              displayName: null,
              targetRoomId: null,
              targetRoomLabel: null,
              targetRoleSlug: "owner",
              codeAvailable: false,
            },
          ],
          page: {
            returned: 2,
            complete: true,
            hasMore: false,
            nextCursor: null,
            continuationAvailable: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await client.listMyInvites();
    expect(out.invites).toHaveLength(2);
    expect(out.invites[0]?.id).toBe("inv_1");
    expect(out.invites[0]?.kind).toBe("server");
    expect(out.invites[1]?.kind).toBe("claim");
    expect(out.page).toEqual({
      returned: 2,
      complete: true,
      hasMore: false,
      nextCursor: null,
      continuationAvailable: true,
    });
  });

  test("revokeInvite calls DELETE /api/invites/:id encoded", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites/inv_xyz`);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.revokeInvite("inv_xyz");
    expect(out).toEqual({
      ok: true,
      mutation: {
        stateChanged: "unknown",
        auditRecorded: "unknown",
        retrySafe: true,
        receiptId: "inv_xyz",
        recovery: [],
      },
    });
  });

  test("listInvites encodes bounded continuation and all scope", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites?all=true&cursor=next-page&limit=25`);
      return new Response(JSON.stringify({ invites: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.listInvites({ all: true, cursor: "next-page", limit: 25 });
    expect(out.page).toEqual({
      returned: 0,
      complete: false,
      hasMore: false,
      nextCursor: null,
      continuationAvailable: false,
    });
  });

  test("getInviteShare returns a validated code and exposes an unavailable error code", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");
    let unavailable = false;

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites/invite%2Fid/share`);
      if (unavailable) {
        return new Response(JSON.stringify({
          error: "invite_code_unavailable",
          code: "invite_code_unavailable",
        }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        code: "inv_secret",
        url: "https://nautilo.example/redeem/inv_secret",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    expect(await client.getInviteShare("invite/id")).toEqual({
      code: "inv_secret",
      url: "https://nautilo.example/redeem/inv_secret",
    });

    unavailable = true;
    try {
      await client.getInviteShare("invite/id");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InviteShareApiError);
      expect(error).toMatchObject({
        status: 409,
        code: "invite_code_unavailable",
      });
    }
  });

  test("public join selection GET and PUT use the admin contract", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");
    const calls: Array<{ url: string; method: string; body: unknown }> = [];

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as unknown
        : null;
      calls.push({
        url: reqUrl(url),
        method: init?.method ?? "GET",
        body,
      });
      return new Response(JSON.stringify({
        inviteId: calls.length === 1 ? null : "invite-id",
        revision: calls.length,
        joinUrl: "https://nautilo.example/join",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    expect(await client.getPublicJoinSelection()).toEqual({
      inviteId: null,
      revision: 1,
      joinUrl: "https://nautilo.example/join",
    });
    expect(await client.updatePublicJoinSelection({
      inviteId: "invite-id",
      revision: 1,
    })).toEqual({
      inviteId: "invite-id",
      revision: 2,
      joinUrl: "https://nautilo.example/join",
    });
    expect(calls).toEqual([
      { url: `${base}/api/admin/public-join`, method: "GET", body: null },
      {
        url: `${base}/api/admin/public-join`,
        method: "PUT",
        body: { inviteId: "invite-id", revision: 1 },
      },
    ]);
  });

  test("getPublicJoinAvailability uses the anonymous strict boolean contract", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("session-token-that-must-not-be-sent");
    let body: unknown = { available: true };

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/public-join`);
      expect(init?.method ?? "GET").toBe("GET");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    expect(await client.getPublicJoinAvailability()).toEqual({ available: true });

    body = { available: false, inviteId: "must-not-be-accepted" };
    expect(await client.getPublicJoinAvailability().catch((error: unknown) => error))
      .toBeInstanceOf(Error);

    body = { available: "true" };
    expect(await client.getPublicJoinAvailability().catch((error: unknown) => error))
      .toBeInstanceOf(Error);
  });

  test("listMyInvites 401 throws ApiError(401, Authentication required)", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("bad");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.listMyInvites();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(401);
      expect(err.message).toBe("Authentication required");
    }
  });
});
